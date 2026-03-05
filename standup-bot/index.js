"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var dotenv = require("dotenv");
var pi_ai_1 = require("@mariozechner/pi-ai");
var rest_1 = require("@octokit/rest");
var libsodium_wrappers_1 = require("libsodium-wrappers");
// Load environment variables from the .env file
dotenv.config();
// ==========================================
// 1. HELPER FUNCTIONS & CONFIG
// ==========================================
function getBasecampHeaders() {
    return {
        "Authorization": "Bearer ".concat(process.env.BASECAMP_ACCESS_TOKEN),
        "Content-Type": "application/json",
        // Basecamp STRICTLY requires a User-Agent with contact info, or they block the request.
        "User-Agent": "StandupBot/1.0 (obhogate48@gmail.com)"
    };
}
function refreshBasecampToken() {
    return __awaiter(this, void 0, void 0, function () {
        var clientId, clientSecret, refreshToken, payload, response, data;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    clientId = process.env.BASECAMP_CLIENT_ID;
                    clientSecret = process.env.BASECAMP_CLIENT_SECRET;
                    refreshToken = process.env.BASECAMP_REFRESH_TOKEN;
                    // 🔥 ADD THIS TEMPORARY LINE:
                    console.log("DEBUG CREDS:", { clientId: clientId, clientSecret: clientSecret, refreshToken: !!refreshToken });
                    if (!clientId || !clientSecret || !refreshToken) {
                        throw new Error("Missing credentials for token renewal.");
                    }
                    console.log("🔄 Basecamp token expired. Attempting to refresh...");
                    payload = new URLSearchParams({
                        type: 'refresh',
                        refresh_token: refreshToken,
                        client_id: clientId,
                        client_secret: clientSecret
                    });
                    return [4 /*yield*/, fetch('https://launchpad.37signals.com/authorization/token', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: payload.toString()
                        })];
                case 1:
                    response = _a.sent();
                    if (!response.ok) {
                        throw new Error("Failed to refresh Basecamp token: ".concat(response.statusText));
                    }
                    return [4 /*yield*/, response.json()];
                case 2:
                    data = _a.sent();
                    console.log("✅ Successfully generated a new Basecamp access token!");
                    // 🔥 NEW: Update the environment variables in memory for the current run
                    process.env.BASECAMP_ACCESS_TOKEN = data.access_token;
                    process.env.BASECAMP_REFRESH_TOKEN = data.refresh_token;
                    // 🔥 NEW: Save the new access token (and refresh token) securely to GitHub for tomorrow
                    return [4 /*yield*/, updateGitHubSecret('BASECAMP_ACCESS_TOKEN', data.access_token)];
                case 3:
                    // 🔥 NEW: Save the new access token (and refresh token) securely to GitHub for tomorrow
                    _a.sent();
                    if (!data.refresh_token) return [3 /*break*/, 5];
                    process.env.BASECAMP_REFRESH_TOKEN = data.refresh_token;
                    return [4 /*yield*/, updateGitHubSecret('BASECAMP_REFRESH_TOKEN', data.refresh_token)];
                case 4:
                    _a.sent();
                    _a.label = 5;
                case 5: return [2 /*return*/, data.access_token];
            }
        });
    });
}
// ==========================================
// SECURE GITHUB SECRET UPDATER
// ==========================================
function updateGitHubSecret(secretName, secretValue) {
    return __awaiter(this, void 0, void 0, function () {
        var owner, repo, githubToken, octokit, publicKeyData, binkey, binsec, encBytes, encryptedValue, error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    owner = process.env.REPO_OWNER;
                    repo = process.env.REPO_NAME;
                    githubToken = process.env.MY_GITHUB_PAT;
                    if (!owner || !repo || !githubToken) {
                        throw new Error("Missing GitHub configuration in environment variables.");
                    }
                    octokit = new rest_1.Octokit({ auth: githubToken });
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 5, , 6]);
                    return [4 /*yield*/, octokit.rest.actions.getRepoPublicKey({
                            owner: owner,
                            repo: repo,
                        })];
                case 2:
                    publicKeyData = (_a.sent()).data;
                    // 2. Encrypt the secret using libsodium
                    return [4 /*yield*/, libsodium_wrappers_1.default.ready];
                case 3:
                    // 2. Encrypt the secret using libsodium
                    _a.sent();
                    binkey = libsodium_wrappers_1.default.from_base64(publicKeyData.key, libsodium_wrappers_1.default.base64_variants.ORIGINAL);
                    binsec = libsodium_wrappers_1.default.from_string(secretValue);
                    encBytes = libsodium_wrappers_1.default.crypto_box_seal(binsec, binkey);
                    encryptedValue = libsodium_wrappers_1.default.to_base64(encBytes, libsodium_wrappers_1.default.base64_variants.ORIGINAL);
                    // 3. Upload the newly encrypted secret
                    return [4 /*yield*/, octokit.rest.actions.createOrUpdateRepoSecret({
                            owner: owner,
                            repo: repo,
                            secret_name: secretName,
                            encrypted_value: encryptedValue,
                            key_id: publicKeyData.key_id,
                        })];
                case 4:
                    // 3. Upload the newly encrypted secret
                    _a.sent();
                    console.log("\uD83D\uDD10 Successfully updated GitHub secret: ".concat(secretName));
                    return [3 /*break*/, 6];
                case 5:
                    error_1 = _a.sent();
                    console.error("\u274C Failed to update GitHub secret (".concat(secretName, "):"), error_1);
                    throw error_1;
                case 6: return [2 /*return*/];
            }
        });
    });
}
// ==========================================
// 2. FETCH DATA FROM BASECAMP (Option 1's 24h filter)
// ==========================================
function fetchBasecampTasks(projectId) {
    return __awaiter(this, void 0, void 0, function () {
        var accountId, baseUrl, response, allEvents, yesterday, recentEvents;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    accountId = process.env.BASECAMP_ACCOUNT_ID;
                    if (!accountId || !process.env.BASECAMP_ACCESS_TOKEN) {
                        throw new Error("Missing Basecamp environment variables in .env file.");
                    }
                    baseUrl = "https://3.basecampapi.com/".concat(accountId, "/projects/").concat(projectId);
                    return [4 /*yield*/, fetch("".concat(baseUrl, "/timeline.json"), {
                            method: 'GET',
                            headers: getBasecampHeaders()
                        })];
                case 1:
                    response = _a.sent();
                    if (!response.ok) {
                        throw new Error("Basecamp API Error for project ".concat(projectId, ": ").concat(response.status, " ").concat(response.statusText));
                    }
                    return [4 /*yield*/, response.json()];
                case 2:
                    allEvents = _a.sent();
                    yesterday = new Date();
                    yesterday.setDate(yesterday.getDate() - 1);
                    recentEvents = allEvents.filter(function (event) {
                        return new Date(event.created_at) >= yesterday;
                    });
                    console.log("\uD83D\uDCE5 Fetched ".concat(recentEvents.length, " events from the last 24 hours for project ").concat(projectId, "."));
                    // Return just the events if there are any, otherwise return null
                    return [2 /*return*/, recentEvents.length > 0 ? recentEvents : null];
            }
        });
    });
}
// ==========================================
// 3. PROCESS WITH AI (Option 1's strict parsing)
// ==========================================
function generateStandupSummary(basecampData) {
    return __awaiter(this, void 0, void 0, function () {
        var model, context, response, summaryText, _i, _a, block;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!process.env.GEMINI_API_KEY) {
                        throw new Error("Missing GEMINI_API_KEY in environment variables.");
                    }
                    model = (0, pi_ai_1.getModel)('google', 'gemini-2.5-flash');
                    context = {
                        systemPrompt: "You are an upbeat, highly organized engineering project manager. \n        Your job is to read raw JSON event data from multiple Basecamp projects and write a combined daily standup summary for the team's Discord channel.\n        Ignore minor events like formatting changes or document tweaks.\n        Focus strictly on:\n        1. Tasks that were COMPLETED yesterday.\n        2. Tasks that are DUE today or were newly ASSIGNED.\n\n        Format the output in clean, readable Discord Markdown (using bolding and emojis). Group by Project.\n        Keep it concise and friendly. Do not include any introductory fluff or JSON blocks in your final output.",
                        messages: [
                            {
                                role: 'user',
                                content: "Here is the recent activity data:\n".concat(JSON.stringify(basecampData).substring(0, 3000)),
                                timestamp: Date.now()
                            }
                        ]
                    };
                    return [4 /*yield*/, (0, pi_ai_1.complete)(model, context)];
                case 1:
                    response = _b.sent();
                    summaryText = "";
                    for (_i = 0, _a = response.content; _i < _a.length; _i++) {
                        block = _a[_i];
                        if (block.type === 'text') {
                            summaryText += block.text;
                        }
                    }
                    if (!summaryText.trim()) {
                        throw new Error("The AI model returned an empty summary.");
                    }
                    return [2 /*return*/, summaryText];
            }
        });
    });
}
// ==========================================
// 4. POST TO DISCORD
// ==========================================
function postToDiscord(summaryMarkdown) {
    return __awaiter(this, void 0, void 0, function () {
        var webhookUrl, payload, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    webhookUrl = process.env.DISCORD_WEBHOOK_URL;
                    if (!webhookUrl) {
                        throw new Error("Missing DISCORD_WEBHOOK_URL in .env file.");
                    }
                    payload = {
                        content: "**\uD83C\uDF1E Good morning, team! Here is your daily standup:**\n\n".concat(summaryMarkdown),
                        username: "Basecamp Standup Bot",
                        avatar_url: "https://i.imgur.com/8nLFCVP.png"
                    };
                    console.log("📤 Sending summary to Discord...");
                    return [4 /*yield*/, fetch(webhookUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        })];
                case 1:
                    response = _a.sent();
                    if (!response.ok) {
                        throw new Error("Discord API Error: ".concat(response.status, " ").concat(response.statusText));
                    }
                    console.log("✅ Message successfully delivered to Discord!");
                    return [2 /*return*/];
            }
        });
    });
}
// ==========================================
// 5. MAIN ORCHESTRATOR (Option 2's loop)
// ==========================================
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var projectIdsString, projectIds, allProjectsData, _i, projectIds_1, projectId, data, summary, error_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log("🚀 Starting Daily Standup Agent...");
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 8, , 9]);
                    projectIdsString = process.env.BASECAMP_PROJECT_IDS;
                    if (!projectIdsString)
                        throw new Error("Missing BASECAMP_PROJECT_IDS in .env file.");
                    projectIds = projectIdsString.split(',').map(function (id) { return id.trim(); });
                    allProjectsData = {};
                    console.log("1️⃣ Fetching data from Basecamp projects...");
                    _i = 0, projectIds_1 = projectIds;
                    _a.label = 2;
                case 2:
                    if (!(_i < projectIds_1.length)) return [3 /*break*/, 5];
                    projectId = projectIds_1[_i];
                    return [4 /*yield*/, fetchBasecampTasks(projectId)];
                case 3:
                    data = _a.sent();
                    // Only add to payload if there was actual activity to save AI tokens
                    if (data) {
                        allProjectsData["Project_".concat(projectId)] = data;
                    }
                    _a.label = 4;
                case 4:
                    _i++;
                    return [3 /*break*/, 2];
                case 5:
                    if (Object.keys(allProjectsData).length === 0) {
                        console.log("😴 No activity in any projects in the last 24 hours. Skipping summary.");
                        return [2 /*return*/]; // Exit successfully
                    }
                    console.log("2️⃣ Processing data with AI...");
                    return [4 /*yield*/, generateStandupSummary(allProjectsData)];
                case 6:
                    summary = _a.sent();
                    console.log("3️⃣ Broadcasting to Discord...");
                    return [4 /*yield*/, postToDiscord(summary)];
                case 7:
                    _a.sent();
                    console.log("✅ Standup posted successfully!");
                    return [3 /*break*/, 9];
                case 8:
                    error_2 = _a.sent();
                    console.error("❌ Fatal Error in Standup Agent:", error_2);
                    process.exit(1);
                    return [3 /*break*/, 9];
                case 9: return [2 /*return*/];
            }
        });
    });
}
// Execute the script
main();
