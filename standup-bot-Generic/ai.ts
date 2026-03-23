import OpenAI from 'openai';
import * as dotenv from 'dotenv';
import { createIssue_GitHub } from './github';
import { syncCommitToTask_Basecamp } from './basecamp';

dotenv.config();

const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
        "HTTP-Referer": "http://localhost:3000", 
        "X-Title": "Tron Standup Bot",
    }
});

export async function generateStandupSummary(basecampData: any): Promise<string> {
    console.log("🧠 Sending data to OpenRouter...");
    
    try {
        const response = await openai.chat.completions.create({
            // 🔥 THE FIX: Use the auto-router to find ANY available free model!
            model: "openrouter/free", 
            messages: [
                { 
                    role: "system", 
                    content: `You are an upbeat, highly organized engineering project manager. 
                    Your job is to read raw JSON event data from multiple Basecamp projects and write a combined daily standup summary for the team's Discord channel.
                    Ignore minor events like formatting changes or document tweaks.
                    Focus strictly on:
                    1. Tasks that were COMPLETED yesterday.
                    2. Tasks that are DUE today or were newly ASSIGNED.

                    Format the output in clean, readable Discord Markdown (using bolding and emojis). Group by Project.
                    Keep it concise and friendly. Do not include any introductory fluff or JSON blocks in your final output.` 
                },
                { 
                    role: "user", 
                    content: JSON.stringify(basecampData) 
                }
            ]
        });

        if (!response.choices[0].message.content) {
            throw new Error("OpenRouter returned an empty response.");
        }

        return response.choices[0].message.content;

    } catch (error: any) {
        console.error("\n❌ OPENROUTER API ERROR:");
        console.error(error.message || error);
        return "⚠️ *Standup bot failed to generate a summary due to an OpenRouter API error. Please check the server logs.*";
    }
}

// 🔥 THE MODULAR AI ROUTER
export async function processGitHubWebhookWithAI(repoName: string, projectName: string, pusherName: string, commits: any[], pmProvider: string) {
    console.log(`🧠 AI is analyzing commits for a ${pmProvider.toUpperCase()} project...`);

    const commitText = commits.map(c => `- ${c.message}`).join('\n');

    const response = await openai.chat.completions.create({
        model: "openrouter/free", 
        messages: [
            { 
                // Notice the generic prompt! No mention of Basecamp.
                role: "system", 
                content: "You are Tron, a universal DevOps automation agent. Read GitHub commit messages and use your tools to sync updates to the team's Project Management software. If a developer pushed code, use the syncCommitToTask tool." 
            },
            { 
                role: "user", 
                content: `Developer '${pusherName}' just pushed code to the '${repoName}' repo (Project Name: '${projectName}'). Here are the commits:\n${commitText}` 
            }
        ],
        // 🛠️ THE GENERIC TOOL MENU
        tools: [
            {
                type: "function",
                function: {
                    name: "syncCommitToTask",
                    description: "Logs a GitHub commit to the connected Project Management software.",
                    parameters: {
                        type: "object",
                        properties: {
                            projectName: { type: "string", description: "The name of the project" },
                            commitMessage: { type: "string", description: "A summary of the code that was changed" },
                            developerName: { type: "string", description: "The name of the developer" }
                        },
                        required: ["projectName", "commitMessage", "developerName"]
                    }
                }
            }
        ],
        // 🚨 THE FIX: Force the AI to use the Basecamp tool every single time!
        tool_choice: { type: "function", function: { name: "syncCommitToTask" } }
    });

    const aiMessage = response.choices[0].message;

    if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
        const toolCall = aiMessage.tool_calls[0];
        
        if (toolCall.type === "function") {
            console.log(`🤖 AI decided to use tool: ${toolCall.function.name}`);
            const args = JSON.parse(toolCall.function.arguments);
            
            // 🔀 THE ADAPTER ROUTER
            if (toolCall.function.name === "syncCommitToTask") {
                if (pmProvider === "basecamp") {
                    await syncCommitToTask_Basecamp(args.projectName, args.commitMessage, args.developerName);
                    return `Successfully synced ${pusherName}'s code to Basecamp!`;
                } 
                // Future proofing:
                // else if (pmProvider === "jira") { await syncCommitToTask_Jira(...) }
            }
        }
    }

    return "AI processed the webhook, but didn't think any tools were necessary.";
}


// 🔥 THE NEW PM-TO-DEV AI ROUTER
export async function processPMWebhookWithAI(taskContent: string, repoName: string, taskId: string, pmProvider: string, creatorName: string, eventDetails: string) {
    console.log(`🧠 AI is analyzing a ${pmProvider.toUpperCase()} event from ${creatorName}...`);

    let response;
    let retries = 3;

    while (retries > 0) {
        try {
            response = await openai.chat.completions.create({
                model: "openrouter/free", 
                messages: [
                    { 
                        role: "system", 
                        content: "You are Tron, a universal DevOps automation agent. Read project management events. If a user creates a new task or to-do, use the createGitHubIssue tool to automatically create a matching issue for the developers. Make the title clear and put the details in the body." 
                    },
                    { 
                        role: "user", 
                        // 🛠️ FIX 1: We are now passing `taskContent` directly to the AI!
                        content: `User '${creatorName}' created a task in ${pmProvider}. The task is: "${taskContent}". Additional details: ${eventDetails}. The target GitHub repo is '${repoName}'.` 
                    }
                ],
                tools: [
                    {
                        type: "function",
                        function: {
                            name: "createGitHubIssue",
                            description: "Creates a new Issue in GitHub for the developers to work on.",
                            parameters: {
                                type: "object",
                                properties: {
                                    repoName: { type: "string", description: "The exact name of the GitHub repository" },
                                    title: { type: "string", description: "The title of the issue" },
                                    body: { type: "string", description: "The body/description of the issue" }
                                },
                                required: ["repoName", "title", "body"]
                            }
                        }
                    }
                ],
                tool_choice: "auto"
            });
            
            break; 

        } catch (error: any) {
            if (error.status === 429) {
                console.log(`⚠️ AI Traffic Jam. Retrying... (${retries - 1} attempts left)`);
                retries--;
                await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
                throw error;
            }
        }
    }

    if (!response || !response.choices || !response.choices[0]) {
        return "Tron tried to sync the task, but the AI returned an invalid response.";
    }

    const aiMessage = response.choices[0].message;

    if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
        const toolCall = aiMessage.tool_calls[0];
        
        if (toolCall.type === "function") {
            try {
                const args = JSON.parse(toolCall.function.arguments);
                
                if (toolCall.function.name === "createGitHubIssue") {
                    
                    // 1. Force the IDE to read it and print it to the terminal!
                    console.log(`🔗 INJECTING BASECAMP ID: ${taskId}`);
                    
                    // 🚨 Make sure the HTML comment and the ${taskId} variable are actually inside the backticks!
                    const bodyWithHiddenId = `${args.body}\n\n<!-- Basecamp Task ID: ${taskId} -->`;
                    
                    // 3. Send it to GitHub
                    const issueUrl = await createIssue_GitHub(args.repoName, args.title, bodyWithHiddenId);
                    
                    return `Successfully created GitHub Issue: ${issueUrl}`;
                }
            } catch (parseError) {
                return "Tron tried to create an issue, but the AI generated invalid JSON.";
            }
        }
    }

    return "AI processed the PM event, but didn't think an issue was necessary.";
}

export async function generatePRSummary(prTitle: string, developerName: string, cleanedDiff: string): Promise<string> {
    console.log(`\n🧠 --- TRON NLP: ANALYZING PULL REQUEST --- 🧠`);
    
    const prompt = `
    You are Tron, a Senior Technical Product Manager. 
    A developer named ${developerName} just opened a Pull Request titled "${prTitle}".
    
    Below is the Git Diff of the code they changed. Your job is to read this code and write a short, plain-English summary for the non-technical Project Managers. 
    
    RULES:
    1. Explain WHAT feature or bug fix this code introduces.
    2. Do NOT mention specific variable names, file names, or code syntax.
    3. Keep it under 3-4 bullet points.
    4. Keep the tone professional, helpful, and concise.

    RAW DIFF:
    ${cleanedDiff}
    `;

    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "openrouter/free", // Or whichever fast/cheap model you prefer!
                messages: [{ role: "user", content: prompt }]
            })
        });

        const data = await response.json();
        
        if (data.choices && data.choices.length > 0) {
            console.log(`✅ PR Summary successfully generated by AI!`);
            return data.choices[0].message.content.trim();
        } else {
            console.error("❌ AI returned an empty response.");
            return "Tron could not generate a summary for this PR.";
        }
    } catch (error: any) {
        console.error("❌ OpenRouter API Error:", error.message);
        return "Tron encountered an error while trying to summarize this PR.";
    }
}
