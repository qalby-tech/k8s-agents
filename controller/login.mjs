// ai_controller — OAuth login helper.
//
// Demonstrates that opencode's OAuth flow is fully driveable over REST, so we
// NEVER ask the user to copy-paste an auth.json. The controller (or our UI)
// orchestrates: list methods -> authorize -> show URL -> user approves in their
// own browser -> (paste code | auto) -> callback -> tokens land in auth.json and
// auto-refresh thereafter.
//
//   node login.mjs <providerId>        e.g. anthropic | github-copilot | openai
//
// Env: OPENCODE_BASE_URL (default http://localhost:4096)
import { createOpencodeClient } from "@opencode-ai/sdk";
import { createInterface } from "node:readline/promises";

const BASE_URL = process.env.OPENCODE_BASE_URL ?? "http://localhost:4096";
const providerID = process.argv[2];
if (!providerID) {
  console.error("usage: node login.mjs <providerId>");
  process.exit(1);
}

const client = createOpencodeClient({ baseUrl: BASE_URL });

// 1. What auth methods does this provider support?
const auth = await client.provider.auth({ path: { id: providerID }, throwOnError: true });
const methods = auth.data?.[providerID] ?? [];
console.log(`[login] ${providerID} methods:`, methods.map((m, i) => `${i}:${m.type}(${m.label})`).join("  "));

const methodIndex = methods.findIndex((m) => m.type === "oauth");
if (methodIndex === -1) {
  console.error(`[login] ${providerID} has no OAuth method — use an API key (client.auth.set).`);
  process.exit(1);
}

// 2. Begin the flow — get the URL the user must visit.
const authz = await client.provider.oauth.authorize({
  path: { id: providerID },
  body: { method: methodIndex },
  throwOnError: true,
});
const { url, method, instructions } = authz.data;
console.log(`\n[login] open this URL and approve:\n  ${url}\n`);
if (instructions) console.log(`[login] ${instructions}\n`);

// 3a. method "auto": loopback/device flow completes itself — just call back.
// 3b. method "code": user pastes the authorization code shown after approving.
let code;
if (method === "code") {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  code = (await rl.question("[login] paste the authorization code: ")).trim();
  rl.close();
}

const result = await client.provider.oauth.callback({
  path: { id: providerID },
  body: { method: methodIndex, ...(code ? { code } : {}) },
  throwOnError: true,
});
console.log("[login] ✓ credentials stored in daemon auth.json — provider now connected.");
console.log("[login] callback result:", JSON.stringify(result.data));
