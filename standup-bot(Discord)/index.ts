import * as dotenv from 'dotenv';
import { getModel, complete, Context } from '@mariozechner/pi-ai';
import { Octokit } from '@octokit/rest';
import sodium from 'libsodium-wrappers';

// Load environment variables from the .env file
dotenv.config();

// ==========================================
// 1. HELPER FUNCTIONS & CONFIG
// ==========================================
function getBasecampHeaders() {
    return {
        "Authorization": `Bearer ${process.env.BASECAMP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        // Basecamp STRICTLY requires a User-Agent with contact info, or they block the request.
        "User-Agent": "StandupBot/1.0 (obhogate48@gmail.com)" 
    };
}

async function refreshBasecampToken(): Promise<string> {
    const clientId = process.env.BASECAMP_CLIENT_ID;
    const clientSecret = process.env.BASECAMP_CLIENT_SECRET;
    const refreshToken = process.env.BASECAMP_REFRESH_TOKEN;

    // 🔥 ADD THIS TEMPORARY LINE:
    console.log("DEBUG CREDS:", { clientId, clientSecret, refreshToken: !!refreshToken });

    if (!clientId || !clientSecret || !refreshToken) {
        throw new Error("Missing credentials for token renewal.");
    }

    console.log("🔄 Basecamp token expired. Attempting to refresh...");

    const payload = new URLSearchParams({
        type: 'refresh',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret
    });

    const response = await fetch('https://launchpad.37signals.com/authorization/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: payload.toString()
    });

    if (!response.ok) {
        throw new Error(`Failed to refresh Basecamp token: ${response.statusText}`);
    }

    const data = await response.json();
    console.log("✅ Successfully generated a new Basecamp access token!");
    
    // 🔥 NEW: Update the environment variables in memory for the current run
    process.env.BASECAMP_ACCESS_TOKEN = data.access_token;
    process.env.BASECAMP_REFRESH_TOKEN = data.refresh_token;
    
    // 🔥 NEW: Save the new access token (and refresh token) securely to GitHub for tomorrow
    await updateGitHubSecret('BASECAMP_ACCESS_TOKEN', data.access_token);
    
    if (data.refresh_token) {
        process.env.BASECAMP_REFRESH_TOKEN = data.refresh_token;
        await updateGitHubSecret('BASECAMP_REFRESH_TOKEN', data.refresh_token);
    }

    return data.access_token; 
}

// Add this helper function
async function fetchAllActiveProjectIds(): Promise<string[]> {
    const accountId = process.env.BASECAMP_ACCOUNT_ID;
    const response = await fetch(`https://3.basecampapi.com/${accountId}/projects.json`, {
        method: 'GET',
        headers: getBasecampHeaders()
    });

    if (!response.ok) throw new Error("Failed to fetch projects list.");
    
    const projects = await response.json();
    // Map through the projects and return just their IDs
    return projects.map((proj: any) => proj.id.toString());
}

// ==========================================
// SECURE GITHUB SECRET UPDATER
// ==========================================
async function updateGitHubSecret(secretName: string, secretValue: string) {
    const owner = process.env.REPO_OWNER; // e.g., "your-username"
    const repo = process.env.REPO_NAME;   // e.g., "standup-bot"
    const githubToken = process.env.MY_GITHUB_PAT; // Your Personal Access Token

    if (!owner || !repo || !githubToken) {
        throw new Error("Missing GitHub configuration in environment variables.");
    }

    const octokit = new Octokit({ auth: githubToken });

    try {
        // 1. Fetch the repository's public key
        const { data: publicKeyData } = await octokit.rest.actions.getRepoPublicKey({
            owner,
            repo,
        });

        // 2. Encrypt the secret using libsodium
        await sodium.ready;
        const binkey = sodium.from_base64(publicKeyData.key, sodium.base64_variants.ORIGINAL);
        const binsec = sodium.from_string(secretValue);
        const encBytes = sodium.crypto_box_seal(binsec, binkey);
        const encryptedValue = sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL);

        // 3. Upload the newly encrypted secret
        await octokit.rest.actions.createOrUpdateRepoSecret({
            owner,
            repo,
            secret_name: secretName,
            encrypted_value: encryptedValue,
            key_id: publicKeyData.key_id,
        });
        
        console.log(`🔐 Successfully updated GitHub secret: ${secretName}`);
    } catch (error) {
        console.error(`❌ Failed to update GitHub secret (${secretName}):`, error);
        throw error;
    }
}

// ==========================================
// 2. FETCH DATA FROM BASECAMP (Option 1's 24h filter)
// ==========================================
async function fetchBasecampTasks(projectId: string) {
    const accountId = process.env.BASECAMP_ACCOUNT_ID;

    if (!accountId || !process.env.BASECAMP_ACCESS_TOKEN) {
        throw new Error("Missing Basecamp environment variables in .env file.");
    }

    const baseUrl = `https://3.basecampapi.com/${accountId}/projects/${projectId}`;

    // First attempt
    let response = await fetch(`${baseUrl}/timeline.json`, {
        method: 'GET',
        headers: getBasecampHeaders()
    });

    // 🔥 THE FIX: Catch the expired token, refresh it, and retry!
    if (response.status === 401) {
        console.log(`Token might be expired for project ${projectId}. Refreshing...`);
        await refreshBasecampToken(); 
        
        // Retry with the freshly generated headers
        response = await fetch(`${baseUrl}/timeline.json`, {
            method: 'GET',
            headers: getBasecampHeaders()
        });
    }

    if (!response.ok) {
        throw new Error(`Basecamp API Error for project ${projectId}: ${response.status} ${response.statusText}`);
    }

    const allEvents = await response.json();

    // Filter for events that happened in the last 24 hours
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const recentEvents = allEvents.filter((event: any) => {
        return new Date(event.created_at) >= yesterday;
    });

    console.log(`📥 Fetched ${recentEvents.length} events from the last 24 hours for project ${projectId}.`);
    
    return recentEvents.length > 0 ? recentEvents : null;
}

// ==========================================
// 3. PROCESS WITH AI (Option 1's strict parsing)
// ==========================================
async function generateStandupSummary(basecampData: any): Promise<string> {
    
    if (!process.env.GEMINI_API_KEY) {
        throw new Error("Missing GEMINI_API_KEY in environment variables.");
    }

    // Tell the pi-ai toolkit to use the official Google provider and your key
    const model = getModel('google', 'gemini-2.5-flash'); 
    
    // Build the conversation context required by pi-ai
    const context: Context = {
      systemPrompt: `You are an upbeat, highly organized engineering project manager. 
        Your job is to read raw JSON event data from multiple Basecamp projects and write a combined daily standup summary for the team's Discord channel.
        Ignore minor events like formatting changes or document tweaks.
        Focus strictly on:
        1. Tasks that were COMPLETED yesterday.
        2. Tasks that are DUE today or were newly ASSIGNED.

        Format the output in clean, readable Discord Markdown (using bolding and emojis). Group by Project.
        Keep it concise and friendly. Do not include any introductory fluff or JSON blocks in your final output.`,
      messages: [
        { 
          role: 'user', 
          content: `Here is the recent activity data:\n${JSON.stringify(basecampData)}`,
          timestamp: Date.now() 
        }
      ]
    };
    
    // Execute the completion
    const response = await complete(model, context);

    // pi-ai returns an array of content blocks; we need to extract the text
    let summaryText = "";
    for (const block of response.content) {
        if (block.type === 'text') {
            summaryText += block.text;
        }
    }

    if (!summaryText.trim()) {
        throw new Error("The AI model returned an empty summary.");
    }

    return summaryText;
}

// ==========================================
// 4. POST TO DISCORD
// ==========================================
async function postToDiscord(summaryMarkdown: string) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

    if (!webhookUrl) {
        throw new Error("Missing DISCORD_WEBHOOK_URL in .env file.");
    }

    const payload = {
        content: `**🌞 Good morning, team! Here is your daily standup:**\n\n${summaryMarkdown}`,
        username: "Basecamp Standup Bot", 
        avatar_url: "https://i.imgur.com/8nLFCVP.png" 
    };

    console.log("📤 Sending summary to Discord...");

    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
         throw new Error(`Discord API Error: ${response.status} ${response.statusText}`);
    }

    console.log("✅ Message successfully delivered to Discord!");
}

// ==========================================
// 5. MAIN ORCHESTRATOR (Option 2's loop)
// ==========================================
async function main() {
    console.log("🚀 Starting Daily Standup Agent...");

    try {
        // Parse project IDs from .env (comma-separated, e.g., "12345,67890")
        const projectIds = await fetchAllActiveProjectIds();
        const allProjectsData: Record<string, any> = {};

        console.log("1️⃣ Fetching data from Basecamp projects...");
        
        for (const projectId of projectIds) {
            const data = await fetchBasecampTasks(projectId);
            // Only add to payload if there was actual activity to save AI tokens
            if (data) {
                allProjectsData[`Project_${projectId}`] = data;
            }
        }

        if (Object.keys(allProjectsData).length === 0) {
            console.log("😴 No activity in any projects in the last 24 hours. Skipping summary.");
            return; // Exit successfully
        }

        console.log("2️⃣ Processing data with AI...");
        const summary = await generateStandupSummary(allProjectsData);

        console.log("3️⃣ Broadcasting to Discord...");
        await postToDiscord(summary);

        console.log("✅ Standup posted successfully!");
    } catch (error) {
        console.error("❌ Fatal Error in Standup Agent:", error);
        process.exit(1);
    }
}

// Execute the script
main();
