import { Octokit } from '@octokit/rest';
import * as dotenv from 'dotenv';

dotenv.config();

/*
 * GITHUB ADAPTER: Creates a new Issue in a specific repository.
*/
export async function createIssue_GitHub(repoName: string, title: string, body: string): Promise<string> {
    console.log(`\n⚙️ --- GITHUB ADAPTER EXECUTED --- ⚙️`);
    console.log(`🎯 Target Repo: ${repoName}`);
    console.log(`📝 Issue Title: ${title}`);
    
    // 🚨 PRE-FLIGHT CHECK: Let's see EXACTLY what ai.ts handed us before sending it to GitHub!
    console.log(`\n=== 🔍 RAW BODY PAYLOAD CHECK ===\n${body}\n=================================\n`);
    
    // Authenticate using the PAT from your .env file
    const octokit = new Octokit({ auth: process.env.MY_GITHUB_PAT });
    const owner = process.env.REPO_OWNER; 

    if (!owner) {
        throw new Error("Missing REPO_OWNER in .env");
    }

    try {
        // Execute the actual GitHub API call!
        const response = await octokit.rest.issues.create({
            owner: owner,
            repo: repoName,
            title: title,
            body: body
        });
        
        console.log(`✅ Status: Issue created successfully at ${response.data.html_url}`);
        console.log(`------------------------------\n`);
        
        return `Successfully created GitHub Issue: ${response.data.html_url}`;
    } catch (error: any) {
        console.error("❌ Failed to create GitHub issue:");
        console.error(error.message);
        return "Failed to create GitHub issue due to an API error.";
    }
}