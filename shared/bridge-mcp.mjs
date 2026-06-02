// bridge-mcp — tools that connect the agent to the human in the chat. Loaded by
// both the per-VM daemon and the AI master (stdio MCP, zero deps). Talks to the
// local agent-bridge server on 127.0.0.1:4097.
//
// Tool: ask_human(question) — register a question the chat surfaces as a prompt,
// then BLOCK until the user answers, returning their reply. Use it whenever you
// need a decision, a credential, or a confirmation you can't safely make alone.
//
// (Sharing files back to the chat needs no tool: copy a file into /workspace/
// outbox/ with your shell and it appears in the chat's attachments tray.)
import { createInterface } from "node:readline";

const BRIDGE = process.env.AGENT_BRIDGE || "http://127.0.0.1:4097";
const PROTOCOL_VERSION = "2024-11-05";
const ASK_TIMEOUT_MS = 15 * 60 * 1000; // give the human up to 15 min to answer

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
  return "No answer from the human within 15 minutes — proceed with your best judgement, or ask again if it's essential.";
}

const TOOLS = {
  ask_human: {
    description:
      "Ask the human user a question and wait for their reply. Use for decisions, " +
      "missing info, credentials, or confirmation before something risky. Blocks " +
      "until they answer (or ~15 min). Returns their exact words.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", description: "what to ask the user" } },
      required: ["question"],
      additionalProperties: false,
    },
    handler: askHuman,
  },
};

// ── MCP stdio JSON-RPC plumbing ──────────────────────────────────────────────
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize")
    return reply(id, {
      protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "bridge-mcp", version: "0.1.0" },
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
      const text = await tool.handler(params?.arguments || {});
      return reply(id, { content: [{ type: "text", text }] });
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
process.stderr.write(`[bridge-mcp] ready; bridge=${BRIDGE}\n`);
