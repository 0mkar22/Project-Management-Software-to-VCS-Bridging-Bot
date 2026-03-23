import express from 'express';
import * as dotenv from 'dotenv';
import fs from 'fs';
import crypto from 'crypto';
import { generateStandupSummary, processGitHubWebhookWithAI, processPMWebhookWithAI,generatePRSummary } from './ai';
import { completeTask_Basecamp, uncompleteTask_Basecamp, fetchAllActiveProjectIds, fetchBasecampTasks, searchBasecampProject } from './basecamp';
import { postToDiscord } from './discord';
import { cleanAndTruncateDiff } from './utils';

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
            // THE ROUTER LOGIC: The engine now knows WHERE to send this!
            console.log(`✅ Authorized! Routing to PM Provider: [${mapping.pmProvider.toUpperCase()}] for project: ${mapping.pmProjectName}`);
            
            try {
                console.log(`🧠 Handing commits over to Tron AI...`);
                // Note: In Phase 4 we will upgrade processGitHubWebhookWithAI to be generic too!
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
        const action = req.body.action; // Will be either 'closed' or 'reopened'
        console.log(`\n🚨 [GITHUB EVENT] Issue ${action.toUpperCase()}: ${req.body?.issue?.title}`);
        
        const issueBody = String(req.body?.issue?.body || "");
        const repoName = req.body?.repository?.name; 

        // 🛡️ THE BULLETPROOF REGEX
        const regex = new RegExp("<!-- Basecamp Task ID: ([^>]+) -->", "i");
        const idMatch = issueBody.match(regex);

        if (idMatch !== null && idMatch[1]) {
            const basecampTaskId = idMatch[1].trim(); 
            console.log(`🔗 Found tethered Basecamp Task ID: ${basecampTaskId}`);
            
            const mapping = config.authorized_repos.find((repo: any) => repo.githubRepo === repoName);
            
            if (mapping && mapping.pmProvider === 'basecamp') {
                console.log(`🔍 Looking up Basecamp Project ID for: '${mapping.pmProjectName}'...`);
                
                const basecampProjectId = await searchBasecampProject(mapping.pmProjectName);

                if (basecampProjectId) {
                    // 🔀 THE FORK IN THE ROAD
                    if (action === 'closed') {
                        await completeTask_Basecamp(basecampProjectId, basecampTaskId);
                        // postToDiscord(`✅ **Auto-Sync:** Issue *${req.body?.issue?.title}* was closed. Tron checked it off in Basecamp!`);
                    } else if (action === 'reopened') {
                        await uncompleteTask_Basecamp(basecampProjectId, basecampTaskId);
                        // postToDiscord(`⚠️ **Auto-Sync:** Issue *${req.body?.issue?.title}* was REOPENED. Tron un-checked it in Basecamp!`);
                    }
                } else {
                    console.log(`❌ Could not find a Basecamp project named ${mapping.pmProjectName}`);
                }
            } else {
                console.log(`🤷‍♂️ Repo ${repoName} is not mapped to Basecamp in config.json.`);
            }
            
        } else {
            console.log(`🤷‍♂️ No hidden Basecamp ID found in this issue. Ignoring.`);
        }
    }
    // 🎯 SCENARIO C: A Developer Opened a Pull Request
    else if (githubEvent === 'pull_request' && req.body?.action === 'opened') {
        const prTitle = req.body.pull_request.title;
        const prUrl = req.body.pull_request.html_url;
        const diffUrl = req.body.pull_request.diff_url; // 🔗 The goldmine!
        const developerName = req.body.pull_request.user.login;
        const repoName = req.body.repository.name;

        console.log(`\n🚨 [GITHUB EVENT] Pull Request Opened: ${prTitle}`);
        console.log(`📥 Fetching raw code changes from: ${diffUrl}`);

        try {
            // Fetch the raw .diff file from GitHub
            // Note: If this is a private repo, we will need to add an Authorization header here later
            const diffResponse = await fetch(diffUrl);
            
            if (diffResponse.ok) {
                const rawDiff = await diffResponse.text();
                console.log(`✅ Successfully downloaded PR Diff! Size: ${rawDiff.length} characters.`);
                
                // 1. Clean and Truncate the code
                const safeDiff = cleanAndTruncateDiff(rawDiff);
                
                // 2. Send it to the AI for a PM Summary
                const aiSummary = await generatePRSummary(prTitle, developerName, safeDiff);
                
                // 3. Post it to Discord (and eventually Basecamp Campfire!)
                const finalMessage = `🚨 **New Pull Request by ${developerName}**\n**Title:** ${prTitle}\n\n**Tron's Executive Summary:**\n${aiSummary}\n\n🔗 [View PR on GitHub](${prUrl})`;
                
                // import { postToDiscord } from './discord'; // Make sure this is imported!
                postToDiscord(finalMessage);
                
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
            const eventDetails = `Event Type: ${kind}. Task Details: "${taskContent}"`;
            
            // Trigger the new AI function!
            // const aiResult = await processPMWebhookWithAI(provider, eventDetails, creator, mapping.githubRepo);
            // Pass the taskId as the third argument!
            const aiResult = await processPMWebhookWithAI(
            taskContent,         // 1st
            mapping.githubRepo,  // 2nd
            taskId,              // 3rd
            provider,            // 4th
            creator,             // 5th
            taskContent          // 6th (using taskContent for eventDetails here)
    );
            
            // Tell Discord what happened!
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
