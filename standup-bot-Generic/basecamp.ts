import * as dotenv from 'dotenv';
import { Octokit } from '@octokit/rest';
import sodium from 'libsodium-wrappers';

dotenv.config();

// ---------------------------------------------------------
// 1. CONFIG & REFRESH LOGIC
// ---------------------------------------------------------
export function getBasecampHeaders() {
    return {
        "Authorization": `Bearer ${process.env.BASECAMP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "StandupBot/1.0 (obhogate48@gmail.com)"
    };
}

let activeAccessToken = process.env.BASECAMP_ACCESS_TOKEN;
let activeRefreshToken = process.env.BASECAMP_REFRESH_TOKEN;
let tokenRefreshPromise: Promise<boolean> | null = null; // 🔒 The Lock!

// 🔄 THE AUTO-REFRESH ENGINE (With Mutex Lock)
async function refreshBasecampToken(): Promise<boolean> {
    
    // 🛑 THE MUTEX CHECK: If a refresh is already happening, just wait for it!
    if (tokenRefreshPromise) {
        console.log(`⏳ [OAUTH] Refresh already in progress. Waiting in line...`);
        return tokenRefreshPromise;
    }

    console.log(`\n🔄 [OAUTH] Access Token expired! Attempting to refresh...`);

    // 🔒 LOCK THE DOOR: Create the promise so other requests have to wait
    tokenRefreshPromise = (async () => {
        const clientId = process.env.BASECAMP_CLIENT_ID;
        const clientSecret = process.env.BASECAMP_CLIENT_SECRET;

        if (!activeRefreshToken || !clientId || !clientSecret) {
            console.error("❌ Missing OAuth credentials. Cannot refresh token.");
            tokenRefreshPromise = null; // 🔓 Unlock the door before leaving
            return false;
        }

        try {
            const response = await fetch(`https://launchpad.37signals.com/authorization/token?type=refresh&refresh_token=${activeRefreshToken}&client_id=${clientId}&client_secret=${clientSecret}`, {
                method: 'POST'
            });

            if (!response.ok) {
                console.error(`❌ OAuth Refresh Failed. Status: ${response.status}`);
                tokenRefreshPromise = null; // 🔓 Unlock the door
                return false;
            }

            const data = await response.json();
            
            // 🔋 Update BOTH tokens in memory!
            activeAccessToken = data.access_token;
            if (data.refresh_token) {
                activeRefreshToken = data.refresh_token; 
            }
            
            console.log(`✅ [OAUTH] Successfully generated new Access Token and Refresh Token!`);
            
            tokenRefreshPromise = null; // 🔓 Unlock the door
            return true;

        } catch (error: any) {
            console.error(`❌ Error during token refresh: ${error.message}`);
            tokenRefreshPromise = null; // 🔓 Unlock the door on error
            return false;
        }
    })();

    return tokenRefreshPromise;
}

// Brought over from your original index.ts!
async function updateGitHubSecret(secretName: string, secretValue: string) {
    const owner = process.env.REPO_OWNER;
    const repo = process.env.REPO_NAME;
    const githubToken = process.env.MY_GITHUB_PAT;

    if (!owner || !repo || !githubToken) return;

    const octokit = new Octokit({ auth: githubToken });
    try {
        const { data: publicKeyData } = await octokit.rest.actions.getRepoPublicKey({ owner, repo });
        await sodium.ready;
        const binkey = sodium.from_base64(publicKeyData.key, sodium.base64_variants.ORIGINAL);
        const binsec = sodium.from_string(secretValue);
        const encBytes = sodium.crypto_box_seal(binsec, binkey);
        const encryptedValue = sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL);

        await octokit.rest.actions.createOrUpdateRepoSecret({
            owner, repo, secret_name: secretName, encrypted_value: encryptedValue, key_id: publicKeyData.key_id,
        });
        console.log(`🔐 Successfully updated GitHub secret: ${secretName}`);
    } catch (error) {
        console.error(`❌ Failed to update GitHub secret (${secretName}):`, error);
    }
}

// ---------------------------------------------------------
// 2. DYNAMIC PROJECT FETCHER
// ---------------------------------------------------------
export async function fetchAllActiveProjectIds(): Promise<string[]> {
    const accountId = process.env.BASECAMP_ACCOUNT_ID;
    if (!accountId) throw new Error("Missing BASECAMP_ACCOUNT_ID in .env");

    let response = await fetch(`https://3.basecampapi.com/${accountId}/projects.json`, {
        method: 'GET',
        headers: getBasecampHeaders()
    });

    // 🔥 THE FIX: Catch the 401, refresh, and retry!
    if (response.status === 401) {
        console.log(`⚠️ 401 Unauthorized detected. Refreshing token...`);
        await refreshBasecampToken(); 
        
        response = await fetch(`https://3.basecampapi.com/${accountId}/projects.json`, {
            method: 'GET',
            headers: getBasecampHeaders()
        });
    }

    if (!response.ok) throw new Error(`Failed to fetch projects: ${response.status} ${response.statusText}`);
    
    const projects = await response.json();
    return projects.map((proj: any) => proj.id.toString());
}

// ---------------------------------------------------------
// 3. TASK FETCHER
// ---------------------------------------------------------
export async function fetchBasecampTasks(projectId: string) {
    const accountId = process.env.BASECAMP_ACCOUNT_ID;
    const baseUrl = `https://3.basecampapi.com/${accountId}/projects/${projectId}`;

    let response = await fetch(`${baseUrl}/timeline.json`, {
        method: 'GET',
        headers: getBasecampHeaders()
    });

    // 🔥 Catch the 401 here too just in case!
    if (response.status === 401) {
        await refreshBasecampToken();
        response = await fetch(`${baseUrl}/timeline.json`, {
            method: 'GET',
            headers: getBasecampHeaders()
        });
    }

    if (!response.ok) {
        console.error(`⚠️ Could not fetch timeline for project ${projectId}. Skipping...`);
        return null;
    }

    const allEvents = await response.json();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const recentEvents = allEvents.filter((event: any) => new Date(event.created_at) >= yesterday);
    return recentEvents.length > 0 ? recentEvents : null;
}

// ---------------------------------------------------------
// 4. AI TOOLS (Phase 4 Adapter)
// ---------------------------------------------------------

/**
 * BASECAMP ADAPTER: Updates a Basecamp project with GitHub commit details.
 */
// 🚨 Notice we added `isRetry: boolean = false` to the arguments!
export async function syncCommitToTask_Basecamp(projectName: string, commitMessage: string, developerName: string, isRetry: boolean = false): Promise<string> {
    console.log(`\n⚙️ --- BASECAMP ADAPTER EXECUTED --- ⚙️`);
    console.log(`🎯 Searching Basecamp for Project: '${projectName}'...`);

    const accountId = process.env.BASECAMP_ACCOUNT_ID;

    // 🛡️ Ensure we have the account ID and the LIVE token in memory
    if (!accountId || !activeAccessToken) {
        console.error("❌ Missing BASECAMP_ACCOUNT_ID or Access Token.");
        return "Failed: Missing credentials.";
    }

    try {
        // 1. Fetch all projects using the active memory token
        const projRes = await fetch(`https://3.basecampapi.com/${accountId}/projects.json`, { 
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${activeAccessToken}`,
                'User-Agent': 'Tron Automation Agent (your@email.com)',
                'Content-Type': 'application/json'
            }
        });

        // 🛡️ THE INTERCEPTOR: Catch the 401 and self-heal!
        if (projRes.status === 401 && !isRetry) {
            console.log(`⚠️ Basecamp returned 401 Unauthorized during commit sync.`);
            const refreshed = await refreshBasecampToken();
            
            if (refreshed) {
                console.log(`🔄 Retrying commit sync with new token...`);
                // Call itself again with the fresh token
                return await syncCommitToTask_Basecamp(projectName, commitMessage, developerName, true); 
            } else {
                return "Failed: OAuth Token Expired and Refresh Failed."; 
            }
        }

        // 🛡️ THE CRASH PREVENTER: Stop immediately if we didn't get a 200 OK
        if (!projRes.ok) {
            console.error(`❌ Basecamp API returned status: ${projRes.status}`);
            return `Failed: Basecamp API error ${projRes.status}`;
        }

        const projects = await projRes.json();

        // Match the name (made case-insensitive to be extra safe)
        const targetProject = projects.find((p: any) => p.name.toLowerCase() === projectName.toLowerCase());

        if (!targetProject) {
            console.log(`❌ Project '${projectName}' not found in Basecamp.`);
            return `Failed: Could not find Basecamp project named ${projectName}.`;
        }

        console.log(`✅ Found Project ID: ${targetProject.id}`);

        // 2. Find the project's Campfire (Chat room) API endpoint
        const campfire = targetProject.dock.find((tool: any) => tool.name === 'chat' || tool.name === 'campfire');

        if (!campfire) {
             console.log(`⚠️ No Campfire found for this project.`);
             return "Failed: This Basecamp project does not have a Campfire chat room.";
        }

        // 3. Post the commit message to the Campfire!
        const postUrl = campfire.url.replace('.json', '/lines.json');
        
        const messagePayload = {
            content: `🚀 **${developerName}** just pushed code via GitHub:\n\n"${commitMessage}"`
        };

        const postRes = await fetch(postUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${activeAccessToken}`, // Use live token here too!
                'User-Agent': 'Tron Automation Agent (your@email.com)',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(messagePayload)
        });

        if (postRes.ok) {
            console.log(`✅ Status: Successfully dropped commit log into Basecamp Campfire!`);
            console.log(`------------------------------\n`);
            return "Successfully updated Basecamp.";
        } else {
            console.error(`❌ Failed to post to Basecamp API. Status: ${postRes.status}`);
            return "Failed to post message to Basecamp Campfire.";
        }

    } catch (error: any) {
        console.error("❌ Basecamp API Error:", error.message);
        return "Failed to sync to Basecamp due to a server error.";
    }
}

// 🚨 Notice we added `isRetry: boolean = false` to the arguments!
export async function completeTask_Basecamp(projectId: string, taskId: string, isRetry: boolean = false): Promise<boolean> {
    console.log(`\n⚙️ --- BASECAMP ADAPTER: COMPLETING TASK --- ⚙️`);
    console.log(`🎯 Target Project ID: ${projectId}`);
    console.log(`✅ Target Task ID: ${taskId}`);

    const accountId = process.env.BASECAMP_ACCOUNT_ID;

    if (!accountId || !activeAccessToken) {
        console.error("❌ Missing BASECAMP_ACCOUNT_ID or Access Token");
        return false;
    }

    try {
        const response = await fetch(`https://3.basecampapi.com/${accountId}/buckets/${projectId}/todos/${taskId}/completion.json`, {
            method: 'POST',
            headers: {
                // 🛡️ THE FIX: Use activeAccessToken, NOT process.env!
                'Authorization': `Bearer ${activeAccessToken}`, 
                'Content-Type': 'application/json',
                'User-Agent': 'Tron Automation Agent (your@email.com)'
            }
        });

        // 🛡️ THE INTERCEPTOR: Catch the 401 and retry!
        if (response.status === 401 && !isRetry) {
            console.log(`⚠️ Basecamp returned 401 Unauthorized for Task Completion.`);
            const refreshed = await refreshBasecampToken();
            
            if (refreshed) {
                console.log(`🔄 Retrying task completion with new token...`);
                return await completeTask_Basecamp(projectId, taskId, true); 
            } else {
                return false; 
            }
        }

        if (response.ok) {
            console.log(`✅ Status: Task ${taskId} successfully marked as completed in Basecamp!`);
            return true;
        } else {
            console.error(`❌ Basecamp API returned status: ${response.status}`);
            return false;
        }
    } catch (error: any) {
        console.error(`❌ Failed to complete Basecamp task: ${error.message}`);
        return false;
    }
}

// 🚨 The "Undo" Function
export async function uncompleteTask_Basecamp(projectId: string, taskId: string, isRetry: boolean = false): Promise<boolean> {
    console.log(`\n⚙️ --- BASECAMP ADAPTER: UN-COMPLETING TASK --- ⚙️`);
    console.log(`🎯 Target Project ID: ${projectId}`);
    console.log(`✅ Target Task ID: ${taskId}`);

    const accountId = process.env.BASECAMP_ACCOUNT_ID;

    if (!accountId || !activeAccessToken) {
        console.error("❌ Missing BASECAMP_ACCOUNT_ID or Access Token");
        return false;
    }

    try {
        const response = await fetch(`https://3.basecampapi.com/${accountId}/buckets/${projectId}/todos/${taskId}/completion.json`, {
            method: 'DELETE', // 🗑️ The magic difference!
            headers: {
                'Authorization': `Bearer ${activeAccessToken}`, 
                'Content-Type': 'application/json',
                'User-Agent': 'Tron Automation Agent (your@email.com)'
            }
        });

        // 🛡️ THE INTERCEPTOR: Catch the 401 and retry!
        if (response.status === 401 && !isRetry) {
            console.log(`⚠️ Basecamp returned 401 Unauthorized for Task Un-Completion.`);
            const refreshed = await refreshBasecampToken();
            
            if (refreshed) {
                console.log(`🔄 Retrying task un-completion with new token...`);
                return await uncompleteTask_Basecamp(projectId, taskId, true); 
            } else {
                return false; 
            }
        }

        // Basecamp often returns 204 No Content for a successful DELETE
        if (response.ok || response.status === 204) {
            console.log(`✅ Status: Task ${taskId} successfully un-checked in Basecamp!`);
            return true;
        } else {
            console.error(`❌ Basecamp API returned status: ${response.status}`);
            return false;
        }
    } catch (error: any) {
        console.error(`❌ Failed to un-complete Basecamp task: ${error.message}`);
        return false;
    }
}

export async function searchBasecampProject(targetProjectName: string, isRetry: boolean = false): Promise<string | null> {
    console.log(`\n🎯 Searching Basecamp for Project: '${targetProjectName}'...`);
    
    const accountId = process.env.BASECAMP_ACCOUNT_ID;

    if (!accountId || !activeAccessToken) {
        console.error("❌ Missing BASECAMP_ACCOUNT_ID or Access Token.");
        return null;
    }

    try {
        const response = await fetch(`https://3.basecampapi.com/${accountId}/projects.json`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${activeAccessToken}`, // Use the active memory token!
                'User-Agent': 'Tron Automation Agent (your@email.com)'
            }
        });

        // 🛡️ THE INTERCEPTOR: Catch the 401!
        if (response.status === 401 && !isRetry) {
            console.log(`⚠️ Basecamp returned 401 Unauthorized.`);
            const refreshed = await refreshBasecampToken();
            
            if (refreshed) {
                // If the refresh worked, recursively call this exact function again!
                return await searchBasecampProject(targetProjectName, true); 
            } else {
                return null; // Refresh failed, give up.
            }
        }

        if (!response.ok) {
            console.error(`❌ Failed to fetch Basecamp projects. API Status: ${response.status}`);
            return null;
        }

        const projects = await response.json();
        const matchedProject = projects.find((p: any) => 
            p.name.toLowerCase() === targetProjectName.toLowerCase()
        );

        if (matchedProject) {
            console.log(`✅ Found Basecamp Project! ID: ${matchedProject.id}`);
            return matchedProject.id.toString();
        } else {
            console.error(`❌ Project '${targetProjectName}' not found in Basecamp.`);
            return null;
        }

    } catch (error: any) {
        console.error(`❌ Error searching Basecamp projects: ${error.message}`);
        return null;
    }
}