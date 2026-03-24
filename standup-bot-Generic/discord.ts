import * as dotenv from 'dotenv';
dotenv.config();

export async function postToDiscord(messageMarkdown: string) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) throw new Error("Missing DISCORD_WEBHOOK_URL");

    const payload = {
        content: `**😁 Hello, team!**\n\n${messageMarkdown}`,
        username: "Standup Bot", 
        avatar_url: "https://i.imgur.com/8nLFCVP.png" 
    };
    console.log("📤 Sending summary to Discord...");

    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
         console.error(`❌ Discord API Error: ${response.status}`);
    } else {
         console.log("✅ Alert successfully delivered to Discord!");
    }
}