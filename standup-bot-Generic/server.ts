import express from 'express';
import * as dotenv from 'dotenv';
import fs from 'fs';
import crypto from 'crypto';
import cron from 'node-cron';
import { generateStandupSummary, processGitHubWebhookWithAI, processPMWebhookWithAI, generatePRSummary, generateWeeklyChangelog } from './ai';
import { PMAdapter } from './adapters/PMAdapter';
import { BasecampAdapter, fetchAllActiveProjectIds, fetchBasecampTasks } from './adapters/basecamp'; // ⬅️ Fixed imports!
import { JiraAdapter } from './adapters/jira';
import { postToDiscord } from './discord';
import { cleanAndTruncateDiff } from './utils';

// 🔌 THE PLUG-AND-PLAY REGISTRY
const adapterRegistry: Record<string, PMAdapter> = {
    'basecamp': BasecampAdapter,
    'jira': JiraAdapter,
};

dotenv.config();

// 🛡️ PRODUCTION CLEANUP 1: Fail-Fast Startup Checker
const requiredEnvVars = ['OPENROUTER_API_KEY', 'BASECAMP_ACCOUNT_ID', 'MY_GITHUB_PAT', 'DISCORD_WEBHOOK_URL'];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        console.error(`🚨 FATAL ERROR: Missing required environment variable: ${envVar}`);
        process.exit(1); // Kill the server immediately so it doesn't fail silently later
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

// 🛡️ THE IRON GATE: We must save the raw, unformatted payload for HMAC cryptography!
app.use(express.json({
    limit: '2mb',
    verify: (req: any, res, buf) => {
        req.rawBody = buf;
    }
}));

// 🛡️ PRODUCTION CLEANUP 2: Strict TypeScript Interfaces
interface RepoMapping {
    githubRepo: string;
    pmProvider: string;
    pmProjectName: string;
}

// Safely parse the config file
let config: { authorized_repos: RepoMapping[] };
try {
    const rawConfig = fs.readFileSync('./config.json', 'utf-8');
    config = JSON.parse(rawConfig);
} catch (error) {
    console.error(`🚨 FATAL ERROR: Could not read or parse config.json. Is the file formatted correctly?`);
    process.exit(1);
}

app.get('/', (req, res) => {
    res.send('🤖 Tron Universal DevOps Router is Online.');
});
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// 🛡️ THE IRON GATE BOUNCER FUNCTION
function verifyGitHubSignature(req: any): boolean {
    const signature = req.headers['x-hub-signature-256'];
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    if (!secret || !signature || !req.rawBody) {
        return false; // Automatically fail if anything is missing
    }

    // Do the exact same SHA-256 math that GitHub did
    const hmac = crypto.createHmac('sha256', secret);
    const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');

    // Compare our math with GitHub's math safely to prevent timing attacks
    try {
        return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature as string));
    } catch (e) {
        return false;
    }
}

// ROUTE 1: The Daily Standup Generator
app.post('/webhook', async (req, res) => {
    console.log('\n📥 ALERT: Received a manual webhook to generate daily standup!');
    res.status(200).send('Webhook received...');
    try {
        const allProjectIds = await fetchAllActiveProjectIds();
        const allProjectsData: Record<string, any> = {};
        for (const projectId of allProjectIds) {
            const data = await fetchBasecampTasks(projectId);
            if (data) allProjectsData[`Project_${projectId}`] = data;
        }
        if (Object.keys(allProjectsData).length === 0) return;
        const summaryMarkdown = await generateStandupSummary(allProjectsData);
        await postToDiscord(summaryMarkdown);
    } catch (error) {
        console.error("❌ Error:", error);
    }
});

// ---------------------------------------------------------
// ROUTE 2: Universal Version Control Webhook (e.g. GitHub)
// ---------------------------------------------------------
app.post('/github-webhook', async (req, res) => {
    
    // 🛑 THE IRON GATE CHECK
    if (!verifyGitHubSignature(req)) {
        console.error("🚨 INTRUDER ALERT: Invalid GitHub Webhook Signature Detected!");
        return res.status(401).send("Unauthorized");
    }

    res.status(200).send('OK'); // It's legit! Acknowledge quickly.
    const githubEvent = req.headers['x-github-event'];
    
    // 🚀 SCENARIO A: A Developer Pushed Code
    if (githubEvent === 'push') {
        const repoName = req.body.repository.name;
        const pusherName = req.body.pusher.name;
        const commits = req.body.commits || []; 
        
        console.log(`\n🐙 [VCS EVENT] Push received from ${pusherName} in repo: ${repoName}`);

        const mapping = config.authorized_repos.find((m: any) => m.githubRepo === repoName);
        
        if (mapping) {
            console.log(`✅ Authorized! Routing to PM Provider: [${mapping.pmProvider.toUpperCase()}] for project: ${mapping.pmProjectName}`);
            
            try {
                console.log(`🧠 Handing commits over to Tron AI...`);
                const aiResult = await processGitHubWebhookWithAI(repoName, mapping.pmProjectName, pusherName, commits, mapping.pmProvider);
                
                let message = `🚀 **${pusherName}** just pushed **${commits.length}** commit(s) to \`${repoName}\`:\n`;
                for (const commit of commits) {
                    message += `- ${commit.message} ([View Code](${commit.url}))\n`;
                }
                message += `\n🤖 **Tron AI Status (${mapping.pmProvider}):** ${aiResult}`; 
                
                await postToDiscord(message);
            } catch (error) {
                console.error("❌ AI Processing Error:", error);
            }
            
        } else {
            console.log(`⚠️ UNAUTHORIZED REPO (${repoName}). Blocked.`);
        }
    }
    // 🎯 SCENARIO B: A Developer Closed OR Reopened an Issue
    else if (githubEvent === 'issues' && ['closed', 'reopened'].includes(req.body?.action)) {
        const action = req.body.action;
        console.log(`\n🚨 [GITHUB EVENT] Issue ${action.toUpperCase()}: ${req.body?.issue?.title}`);
        
        const issueBody = String(req.body?.issue?.body || "");
        const repoName = req.body?.repository?.name; 

        // 🛡️ THE BULLETPROOF REGEX
        const regex = new RegExp("", "i");
        const idMatch = issueBody.match(regex);

        if (idMatch !== null && idMatch[1]) {
            const pmTaskId = idMatch[1].trim(); 
            console.log(`🔗 Found tethered Task ID: ${pmTaskId}`);
            
            const mapping = config.authorized_repos.find((repo: any) => repo.githubRepo === repoName);
            
            if (mapping && mapping.pmProvider) {
                // 🔌 THE ROUTER MAGIC: Grab the correct adapter!
                const activeAdapter = adapterRegistry[mapping.pmProvider];

                if (activeAdapter) {
                    console.log(`🔍 Looking up Project ID for: '${mapping.pmProjectName}' via ${mapping.pmProvider.toUpperCase()}...`);
                    const pmProjectId = await activeAdapter.searchProject(mapping.pmProjectName);

                    if (pmProjectId) {
                        // 🔀 THE FORK IN THE ROAD
                        if (action === 'closed') {
                            await activeAdapter.completeTask(pmProjectId, pmTaskId);
                        } else if (action === 'reopened') {
                            await activeAdapter.uncompleteTask(pmProjectId, pmTaskId);
                        }
                    } else {
                        console.log(`❌ Could not find a project named ${mapping.pmProjectName} in ${mapping.pmProvider}`);
                    }
                } else {
                    console.error(`❌ Adapter for ${mapping.pmProvider} is not registered in Tron!`);
                }
            } else {
                console.log(`🤷‍♂️ Repo ${repoName} is not mapped in config.json.`);
            }
            
        } else {
            console.log(`🤷‍♂️ No hidden Task ID found in this issue. Ignoring.`);
        }
    }
    // 🎯 SCENARIO C: A Developer Opened a Pull Request
    else if (githubEvent === 'pull_request' && req.body?.action === 'opened') {
        const prTitle = req.body.pull_request.title;
        const prUrl = req.body.pull_request.html_url;
        const diffUrl = req.body.pull_request.diff_url;
        const developerName = req.body.pull_request.user.login;
        const repoName = req.body.repository.name;

        console.log(`\n🚨 [GITHUB EVENT] Pull Request Opened: ${prTitle}`);
        console.log(`📥 Fetching raw code changes from: ${diffUrl}`);

        try {
            const diffResponse = await fetch(diffUrl);
            
            if (diffResponse.ok) {
                const rawDiff = await diffResponse.text();
                console.log(`✅ Successfully downloaded PR Diff! Size: ${rawDiff.length} characters.`);
                
                const safeDiff = cleanAndTruncateDiff(rawDiff);
                const aiSummary = await generatePRSummary(prTitle, developerName, safeDiff);
                
                const finalMessage = `🚨 **New Pull Request by ${developerName}**\n**Title:** ${prTitle}\n\n**Tron's Executive Summary:**\n${aiSummary}\n\n🔗 [View PR on GitHub](${prUrl})`;
                postToDiscord(finalMessage);

                const mapping = config.authorized_repos.find((repo: any) => repo.githubRepo === repoName);
                
                if (mapping && mapping.pmProvider) {
                    // 🔌 THE ROUTER MAGIC: Grab the correct adapter!
                    const activeAdapter = adapterRegistry[mapping.pmProvider];

                    if (activeAdapter) {
                        console.log(`🔍 Routing AI Summary to ${mapping.pmProvider.toUpperCase()} Project: '${mapping.pmProjectName}'...`);
                        await activeAdapter.postPRSummary(mapping.pmProjectName, prTitle, developerName, aiSummary, prUrl);
                    } else {
                        console.error(`❌ Adapter for ${mapping.pmProvider} is not registered in Tron!`);
                    }
                } else {
                    console.log(`🤷‍♂️ Repo ${repoName} is not mapped in config.json. Skipping PM update.`);
                }
                
            } else {
                console.error(`❌ Failed to download PR Diff. Status: ${diffResponse.status}`);
            }
        } catch (error: any) {
            console.error(`❌ Error fetching PR Diff: ${error.message}`);
        }
    }
});

// ---------------------------------------------------------
// ROUTE 3: Universal PM Webhook (PM -> Dev Flow)
// ---------------------------------------------------------
app.post('/pm-webhook/:provider', async (req, res) => {
    
    // 🛑 THE UNIVERSAL IRON GATE
    const providedToken = req.query.token;
    const expectedToken = process.env.UNIVERSAL_WEBHOOK_SECRET;

    if (!providedToken || providedToken !== expectedToken) {
        console.error(`🚨 INTRUDER ALERT: Unauthorized access attempt to /pm-webhook/${req.params.provider}`);
        return res.status(401).send("Unauthorized");
    }

    res.status(200).send('Webhook received'); // Acknowledge quickly
    const provider = req.params.provider; 
    
    const kind = req.body.kind || "unknown_event";
    const creator = req.body.creator?.name || req.body.creator || "Someone";
    
    // 🛑 THE GHOST ECHO FILTER
    if (creator === "Tron Automation Agent" || creator === "YOUR_BOTS_BASECAMP_NAME") {
        console.log(`👻 Ghost Echo detected: Ignoring webhook triggered by Tron.`);
        return res.status(200).send("Ignored Bot Event");
    }
    const projectName = req.body.recording?.bucket?.name || req.body.projectName;
    const taskContent = req.body.recording?.title || req.body.recording?.content || req.body.taskContent || "New item created";
    const taskId = req.body.recording?.id || "unknown_id";
    
    // 🛡️ THE BOUNCER: Ignore everything except actual task creations!
    if (provider === "basecamp" && kind !== "todo_created") {
        console.log(`\n🙈 [PM EVENT] Ignoring background Basecamp event: ${kind}`);
        return; // Stop running the code!
    }

    console.log(`\n📋 [PM EVENT] Received webhook from provider: [${provider.toUpperCase()}]`);
    console.log(`↳ Extracted Project: ${projectName} | Task: ${taskContent}`);

    // 🔄 REVERSE LOOKUP: Find the GitHub repo linked to this PM project!
    const mapping = config.authorized_repos.find((m: any) => m.pmProvider === provider && m.pmProjectName === projectName);

    if (mapping) {
        console.log(`✅ Authorized PM Project matched! Associated GitHub Repo: ${mapping.githubRepo}`);
        
        try {
            console.log(`🧠 Handing PM event over to Tron AI...`);
            
            const aiResult = await processPMWebhookWithAI(
                taskContent,        // 1st
                mapping.githubRepo, // 2nd
                taskId,             // 3rd
                provider,           // 4th
                creator,            // 5th
                taskContent         // 6th (using taskContent for eventDetails here)
            );
            
            let message = `📋 **${creator}** created a new task in **${projectName}** (${provider}).\n`;
            message += `🤖 **Tron AI Status:** ${aiResult}`; 
            
            await postToDiscord(message);
        } catch (error) {
            console.error("❌ AI Processing Error:", error);
        }
    } else {
        console.log(`⚠️ UNAUTHORIZED OR UNMAPPED PM PROJECT (${projectName}). Blocked.`);
    }
});

// ---------------------------------------------------------
// ⏰ THE WEEKLY AGGREGATION ENGINE (Cron Job)
// ---------------------------------------------------------

cron.schedule('0 17 * * 5', async () => {
    console.log('\n⏰ [CRON] Executing Weekly Aggregation Engine...');
    
    // 1. Get a unique list of all PM projects from our config file
    const uniqueProjects = [...new Set(config.authorized_repos.map(r => JSON.stringify({ provider: r.pmProvider, name: r.pmProjectName })))].map(s => JSON.parse(s));

    for (const proj of uniqueProjects) {
        const activeAdapter = adapterRegistry[proj.provider];
        if (!activeAdapter) continue;

        console.log(`🔍 [CRON] Processing Project: ${proj.name} (${proj.provider})`);
        
        // 2. Look up the project ID
        const projectId = await activeAdapter.searchProject(proj.name);
        
        if (projectId) {
            // 3. Fetch the 7-day data
            const weeklyTasks = await activeAdapter.fetchWeeklyCompletedTasks(projectId);
            
            // 4. Send to the AI Chief of Staff
            const summary = await generateWeeklyChangelog(proj.name, weeklyTasks);
            
            // 5. Post the Newsletter to Discord!
            const finalMessage = `📢 **Weekly Velocity Report: ${proj.name}**\n\n${summary}`;
            await postToDiscord(finalMessage);
        }
    }
}, {
    timezone: "Asia/Kolkata"
});

app.listen(PORT, () => {
    // 🛟 GLOBAL SAFETY NET: Prevent the server from crashing if an unknown error occurs
    process.on('uncaughtException', (error) => {
        console.error('🚨 [CRITICAL] Uncaught Exception caught! Server stays alive.', error);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('🚨 [CRITICAL] Unhandled Promise Rejection caught! Server stays alive.', reason);
    });
    console.log(`🚀 Tron Universal Router is awake at http://localhost:${PORT}`);
    console.log(`👂 Listening for VCS events at /github-webhook`);
    console.log(`👂 Listening for PM events at /pm-webhook/:provider`);
});