import express from 'express';
import * as dotenv from 'dotenv';
import fs from 'fs';
import { generateStandupSummary, processGitHubWebhookWithAI, processPMWebhookWithAI } from './ai';
import { fetchAllActiveProjectIds, fetchBasecampTasks } from './basecamp';
import { postToDiscord } from './discord';

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

app.use(express.json());

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
    res.status(200).send('OK');
    const githubEvent = req.headers['x-github-event'];
    
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
});

// ---------------------------------------------------------
// ROUTE 3: Universal Project Management Webhook (PM -> Dev Flow)
// ---------------------------------------------------------
app.post('/pm-webhook/:provider', async (req, res) => {
    res.status(200).send('OK');
    const provider = req.params.provider; 
    
    const kind = req.body.kind || "unknown_event";
    const creator = req.body.creator?.name || req.body.creator || "Someone";
    const projectName = req.body.recording?.bucket?.name || req.body.projectName;
    const taskContent = req.body.recording?.title || req.body.recording?.content || req.body.taskContent || "New item created";
    
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
            const aiResult = await processPMWebhookWithAI(provider, eventDetails, creator, mapping.githubRepo);
            
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
    console.log(`🚀 Tron Universal Router is awake at http://localhost:${PORT}`);
    console.log(`👂 Listening for VCS events at /github-webhook`);
    console.log(`👂 Listening for PM events at /pm-webhook/:provider`);
});
