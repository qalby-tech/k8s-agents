// bridge-mcp — tools connecting the agent to the human + the chat. Loaded by the
// per-VM daemon and the AI master (stdio MCP, zero deps). Talks to the local
// agent-bridge on 127.0.0.1:4097 and (on a daemon) reuses the `fleet` CLI.
//
// Tools:
//   ask_human(question)            both roles — ask the user, block for the reply
//   share_file(path, caption, from) both roles — put a file in the chat's outbox
//   screenshot()                   daemon only — capture the VM screen, return it
//                                  as a native image (vision models see it directly)
//
// Security: these add NO network listener and NO capability the agent doesn't
// already have through `fleet`. The one new risk — share_file reading a pod-local
// file into the user-downloadable outbox — is locked to an allowlist so it can
// never exfiltrate the daemon's secrets (SSH key, vm_password, provider auth.json).
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { readFile, copyFile, unlink, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";

const BRIDGE = process.env.AGENT_BRIDGE || "http://127.0.0.1:4097";
const OUTBOX = process.env.AGENT_OUTBOX || "/workspace/outbox";
const PROTOCOL_VERSION = "2024-11-05";
const ASK_TIMEOUT_MS = 15 * 60 * 1000;
// Daemon (has a VM) vs master. The screenshot tool only exists on a daemon.
const IS_DAEMON = existsSync("/etc/aidaemon/vm_user");
// share_file (from=local) may only copy files the agent legitimately produced —
// never the mounted secrets/keys/credentials. Allowlist, resolved through
// symlinks, so nothing under /etc/aidaemon, /root/.ssh or the opencode auth.json
// can be surfaced to the user.
const SHARE_ROOTS = ["/workspace", "/tmp"];

function run(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message || "").toString().slice(0, 500))) : resolve(stdout),
    );
  });
}

async function jfetch(url, opts = {}, timeoutMs = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    const text = await r.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { ok: r.ok, status: r.status, body };
  } finally {
    clearTimeout(t);
  }
}

// ── tools ────────────────────────────────────────────────────────────────────

async function askHuman({ question }) {
  if (!question || !String(question).trim()) throw new Error("ask_human requires a non-empty question");
  const created = await jfetch(`${BRIDGE}/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: String(question) }),
  });
  if (!created.ok || !created.body?.id) throw new Error(`could not post the question (status ${created.status})`);
  const id = created.body.id;
  const deadline = Date.now() + ASK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const w = await jfetch(`${BRIDGE}/ask/wait?id=${encodeURIComponent(id)}`, {}, 30000).catch(() => null);
    if (w?.body?.answered) return `The human answered:\n\n${w.body.answer}`;
  }
  return "No answer from the human within 15 minutes — use your best judgement, or ask again if essential.";
}

async function recordCaption(name, caption) {
  if (!caption) return;
  const file = join(OUTBOX, ".captions.json");
  let map = {};
  try { map = JSON.parse(await readFile(file, "utf8")); } catch {}
  map[name] = String(caption);
  await writeFile(file, JSON.stringify(map)).catch(() => {});
}

async function shareFile({ path, caption, from }) {
  if (!path) throw new Error("share_file requires { path }");
  await mkdir(OUTBOX, { recursive: true }).catch(() => {});
  const name = basename(String(path)) || "file";
  const dest = join(OUTBOX, name);
  if (from === "vm") {
    if (!IS_DAEMON) throw new Error("from:'vm' is only available on a VM daemon");
    // Pulls from the user's own VM — no pod secrets involved. fleet handles SSH.
    await run("fleet", ["pull", "vm", String(path), dest]);
  } else {
    // Local pod file: must resolve inside the allowlist (blocks secrets/keys).
    let real;
    try { real = await realpath(String(path)); } catch { throw new Error(`no such file: ${path}`); }
    if (!SHARE_ROOTS.some((root) => real === root || real.startsWith(root + "/")))
      throw new Error("share_file (local) only allows files under /workspace or /tmp");
    const st = await stat(real);
    if (!st.isFile()) throw new Error("not a regular file");
    await copyFile(real, dest);
  }
  await recordCaption(name, caption);
  return `Shared "${name}" with the user — it's in the chat's attachments.${caption ? ` (${caption})` : ""}`;
}

async function screenshot() {
  if (!IS_DAEMON) throw new Error("screenshot is only available on a VM daemon");
  const tmp = `/tmp/mcp-screen-${Date.now()}.png`;
  // Reuse the fleet CLI (cua /cmd over SSH + decode) — same capability the agent
  // already has; this just returns the bytes as a native image to the model.
  await run("fleet", ["screenshot", "vm", tmp], 60000);
  const buf = await readFile(tmp);
  await mkdir(OUTBOX, { recursive: true }).catch(() => {});
  await copyFile(tmp, join(OUTBOX, "screen.png")).catch(() => {}); // so the user sees it too
  await unlink(tmp).catch(() => {});
  return {
    content: [
      { type: "text", text: "Screenshot of the VM (saved to /workspace/outbox/screen.png). If your model is text-only, run analyze_image on that path instead." },
      { type: "image", data: buf.toString("base64"), mimeType: "image/png" },
    ],
  };
}

const TOOLS = {
  ask_human: {
    description:
      "Ask the human user a question and wait for their reply. Use for decisions, " +
      "missing info, credentials, or confirmation before something risky. Blocks " +
      "until they answer (~15 min). Returns their exact words.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", description: "what to ask the user" } },
      required: ["question"],
      additionalProperties: false,
    },
    handler: askHuman,
  },
  share_file: {
    description:
      "Share a file with the user — it appears in the chat's attachments. Use it " +
      "to hand back a generated document, a log, a result. from:'vm' pulls the " +
      "file from the VM first; otherwise the path must be a file you created under " +
      "/workspace or /tmp.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "file path (on the VM if from='vm', else under /workspace or /tmp)" },
        caption: { type: "string", description: "optional one-line note shown with the file" },
        from: { type: "string", enum: ["local", "vm"], description: "where the file is (default local)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: shareFile,
  },
};
if (IS_DAEMON) {
  TOOLS.screenshot = {
    description:
      "Capture the VM screen and return it as an image you can see directly (use " +
      "this instead of fleet screenshot + reading a file). Loop: screenshot -> read " +
      "it -> act (click/type) -> screenshot to confirm.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: screenshot,
  };
}

// ── MCP stdio JSON-RPC plumbing ──────────────────────────────────────────────
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const toContent = (r) => (r && typeof r === "object" && Array.isArray(r.content) ? r : { content: [{ type: "text", text: String(r) }] });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize")
    return reply(id, {
      protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "bridge-mcp", version: "0.2.0" },
    });
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list")
    return reply(id, {
      tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
    });
  if (method === "tools/call") {
    const tool = TOOLS[params?.name];
    if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const out = await tool.handler(params?.arguments || {});
      return reply(id, toContent(out));
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: `ERROR: ${e?.message || e}` }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { return; }
  Promise.resolve(handle(msg)).catch((e) => process.stderr.write(`[bridge-mcp] ${e?.stack || e}\n`));
});
process.stderr.write(`[bridge-mcp] ready; bridge=${BRIDGE} daemon=${IS_DAEMON}\n`);
