// fleet-mcp — the AI Master's orchestration tools, exposed to opencode as a
// local MCP server (stdio, newline-delimited JSON-RPC 2.0; zero deps).
//
// The master is a normal opencode engine with NO VM. Instead of a `fleet` SSH
// wrapper, it drives its *slave AI daemons* over their own opencode HTTP API
// (<slave>-aidaemon:4096). delegate() creates a real session on a slave and
// prompts it, so the run shows up in THAT daemon's chat history exactly as if
// the user had typed it — the master just decides who does what and aggregates.
//
// Targets come from the master Secret at /etc/aimaster/targets.json:
//   [{ "name", "kind", "daemonURL", "model": "providerID/modelID", "instructions" }]
//
// Tools: list_agents, delegate(agent, task), check(agent, session).
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const TARGETS_PATH = process.env.FLEET_TARGETS || "/etc/aimaster/targets.json";
const BRIDGE = process.env.AGENT_BRIDGE || "http://127.0.0.1:4097"; // the master's own bridge
const PROTOCOL_VERSION = "2024-11-05";

// A slave's agent-bridge (:4097) sits next to its opencode API (:4096). That's
// where its pending ask_human question and its shared files live.
const bridgeOf = (t) => t.daemonURL.replace(/\/+$/, "").replace(/:4096$/, ":4097");

function loadTargets() {
  try {
    const arr = JSON.parse(readFileSync(TARGETS_PATH, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
const findTarget = (name) => loadTargets().find((t) => t.name === name);

// Slaves live behind a ClusterIP with no extra crypto, but a hung slave must not
// hang the master — every call is time-boxed.
async function jfetch(url, opts = {}, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    const text = await r.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { ok: r.ok, status: r.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// "providerID/modelID" -> { providerID, modelID }; the model must exist on the
// slave's own provider (the slave runs with its own credentials).
function parseModel(m) {
  if (!m || typeof m !== "string") return null;
  const i = m.indexOf("/");
  if (i < 0) return null;
  return { providerID: m.slice(0, i), modelID: m.slice(i + 1) };
}

// ── tools ────────────────────────────────────────────────────────────────────

async function listAgents() {
  const agents = loadTargets().map((t) => ({
    name: t.name,
    kind: t.kind || "terminal",
    model: t.model || "(agent default)",
    instructions: t.instructions || "",
  }));
  if (!agents.length) return "No agents are attached to this master yet.";
  return JSON.stringify(agents, null, 2);
}

async function delegate({ agent, task }) {
  if (!agent || !task) throw new Error("delegate requires { agent, task }");
  const t = findTarget(agent);
  if (!t) throw new Error(`unknown agent "${agent}" — call list_agents first`);
  const base = t.daemonURL.replace(/\/+$/, "");

  const created = await jfetch(`${base}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: `via master: ${task.slice(0, 60)}` }),
  });
  if (!created.ok || !created.body?.id)
    throw new Error(`could not start a session on "${agent}" (status ${created.status})`);
  const sessionId = created.body.id;

  const prompt = (t.instructions ? `${t.instructions}\n\n` : "") + task;
  const body = { parts: [{ type: "text", text: prompt }] };
  const model = parseModel(t.model);
  if (model) body.model = model;

  const sent = await jfetch(`${base}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!sent.ok)
    throw new Error(`agent "${agent}" rejected the task (status ${sent.status})`);

  // Register an async watch with our own bridge: when this agent finishes (or
  // errors / blocks on a human / stalls), the bridge injects a user message back
  // into THIS master chat so we're re-prompted to evaluate it — no blocking wait.
  const watch = await jfetch(`${BRIDGE}/watch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slaveBase: base, slaveBridge: bridgeOf(t), session: sessionId, agent, task }),
  }).catch(() => null);

  const armed = watch?.ok && watch.body?.ok;
  return (
    `Delegated to "${agent}" (session ${sessionId}). It's now working in its own chat.\n\n` +
    (armed
      ? `You will be AUTOMATICALLY notified in this chat the moment it finishes (or errors, stalls, or ` +
        `needs a human). Do NOT wait or poll — just delegate any other tasks now and end your turn; ` +
        `you'll be woken to evaluate each result as it lands.`
      : `(Auto-notify could not be armed — fall back to a single check({ agent: "${agent}", session: ` +
        `"${sessionId}" }) when you expect it to be done.)`)
  );
}

// Deprecated. Delegation now auto-notifies the master on completion (the bridge
// /watch mechanism wakes this chat). Kept as a shim so a master still running an
// older AGENTS.md that calls await_agent doesn't hit "unknown tool" — it just
// does one status glance and tells the master to stop waiting.
async function awaitAgent(args) {
  if (!args?.agent || !args?.session) throw new Error("await_agent requires { agent, session }");
  let status = "";
  try { status = await check(args); } catch { /* ignore */ }
  return (
    `(You don't need await_agent anymore — you're notified automatically in this chat when ` +
    `"${args.agent}" finishes, errors, stalls, or needs a human. Just end your turn.)\n\n` +
    (status || "")
  ).trim();
}

async function check({ agent, session }) {
  if (!agent || !session) throw new Error("check requires { agent, session }");
  const t = findTarget(agent);
  if (!t) throw new Error(`unknown agent "${agent}"`);
  const base = t.daemonURL.replace(/\/+$/, "");

  const r = await jfetch(`${base}/session/${encodeURIComponent(session)}/message`);
  if (!r.ok) throw new Error(`could not read session ${session} on "${agent}" (status ${r.status})`);
  const msgs = Array.isArray(r.body) ? r.body : [];

  // Walk to the last assistant message; collect its text, note tools + completion.
  let lastAssistant = null;
  let running = false;
  for (const m of msgs) {
    const info = m.info || m;
    const parts = m.parts || [];
    if ((info.role || "") === "assistant") lastAssistant = m;
    for (const p of parts) {
      if (p.type === "tool" && p.state && (p.state.status === "running" || p.state.status === "pending"))
        running = true;
    }
  }
  if (!lastAssistant) return `Agent "${agent}" has not responded yet (still starting up).`;

  const info = lastAssistant.info || lastAssistant;
  const done = !!info?.time?.completed;
  const text = (lastAssistant.parts || [])
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join("\n")
    .trim();
  const status = running ? "WORKING" : done ? "DONE" : "WORKING";

  // Out-of-band channels the slave can't put in its own transcript: a pending
  // human question (it's blocked) and any files it shared. Surface them so the
  // master can relay/answer and collect.
  const bridge = bridgeOf(t);
  let extra = "";
  const ask = await jfetch(`${bridge}/ask`).catch(() => null);
  if (ask?.body?.pending) {
    extra +=
      `\n\n⚠ "${agent}" IS WAITING ON A HUMAN. It asked: "${ask.body.pending.question}"\n` +
      `Resolve it: relay to the user with ask_human and pass their reply back via ` +
      `answer_agent({ agent: "${agent}", answer }), OR — only if you're permitted to ` +
      `decide for the user — answer it yourself with answer_agent.`;
  }
  const ob = await jfetch(`${bridge}/outbox`).catch(() => null);
  const files = (ob?.body?.files || []).map((f) => f.name);
  if (files.length)
    extra += `\n\nFiles "${agent}" shared: ${files.join(", ")}. Surface one to the user with collect_file({ agent: "${agent}", name }).`;

  return (
    `Agent "${agent}" — ${status}.\n\n` +
    (text || "(no text output yet)") +
    (status === "WORKING" && !extra ? `\n\n(Call check again in a few seconds for more.)` : "") +
    extra
  );
}

async function answerAgent({ agent, answer }) {
  if (!agent || answer === undefined) throw new Error("answer_agent requires { agent, answer }");
  const t = findTarget(agent);
  if (!t) throw new Error(`unknown agent "${agent}"`);
  const bridge = bridgeOf(t);
  const ask = await jfetch(`${bridge}/ask`);
  const pending = ask.body?.pending;
  if (!pending) return `"${agent}" has no pending question right now (nothing to answer).`;
  const r = await jfetch(`${bridge}/ask/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: pending.id, answer: String(answer) }),
  });
  if (!r.ok) throw new Error(`could not deliver the answer to "${agent}" (status ${r.status})`);
  return `Answered "${agent}"'s question ("${pending.question}") with: ${answer}`;
}

async function collectFile({ agent, name, caption }) {
  if (!agent || !name) throw new Error("collect_file requires { agent, name }");
  const t = findTarget(agent);
  if (!t) throw new Error(`unknown agent "${agent}"`);
  const safe = basename(String(name));
  // Fetch from the slave's active session outbox, then post to OUR active
  // session outbox (this master chat) so it shows here.
  const r = await fetch(`${bridgeOf(t)}/outbox/${encodeURIComponent(safe)}`).catch(() => null);
  if (!r || !r.ok) throw new Error(`could not fetch "${safe}" from "${agent}"`);
  const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
  const post = await jfetch(`${BRIDGE}/outbox`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: safe, data: b64, caption: `from ${agent}${caption ? `: ${caption}` : ""}` }),
  });
  if (!post.ok) throw new Error(`could not surface "${safe}" (status ${post.status})`);
  return `Collected "${safe}" from "${agent}" — it's now in this chat's attachments.`;
}

const TOOLS = {
  list_agents: {
    description:
      "List the AI agents attached to this master (name, kind gui/terminal, model). " +
      "Call this first to see who you can delegate to.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: listAgents,
  },
  delegate: {
    description:
      "Hand a task to one agent. It runs in that agent's own chat/session using its " +
      "configured model. You are AUTOMATICALLY re-prompted in this chat when it finishes " +
      "(or errors / stalls / needs a human) — do NOT wait or poll. Delegate freely and end " +
      "your turn; each result wakes you to evaluate it.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "agent name from list_agents" },
        task: { type: "string", description: "the full instruction for that agent" },
      },
      required: ["agent", "task"],
      additionalProperties: false,
    },
    handler: delegate,
  },
  await_agent: {
    description:
      "Deprecated — you are notified automatically when a delegated agent finishes, so you " +
      "do not need to wait. Calling this just confirms that and gives a one-off status; then " +
      "end your turn.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        session: { type: "string", description: "session id returned by delegate" },
      },
      required: ["agent", "session"],
      additionalProperties: false,
    },
    handler: awaitAgent,
  },
  check: {
    description:
      "Peek at an agent's progress once (non-blocking) — for an optional status glance. You " +
      "do NOT need this to learn when an agent is done: delegate auto-notifies you. Also " +
      "surfaces a blocked human-question / shared files.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        session: { type: "string", description: "session id returned by delegate" },
      },
      required: ["agent", "session"],
      additionalProperties: false,
    },
    handler: check,
  },
  answer_agent: {
    description:
      "Deliver an answer to an agent that is blocked on a human question (check shows " +
      "this). Use it to pass back the user's reply (relay), or your own decision if you " +
      "are permitted to decide for the user.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        answer: { type: "string", description: "the answer to unblock the agent with" },
      },
      required: ["agent", "answer"],
      additionalProperties: false,
    },
    handler: answerAgent,
  },
  collect_file: {
    description:
      "Pull a file an agent shared (see check) into THIS chat's attachments so the user " +
      "sees it here.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        name: { type: "string", description: "the file name from check" },
        caption: { type: "string" },
      },
      required: ["agent", "name"],
      additionalProperties: false,
    },
    handler: collectFile,
  },
};

// ── MCP stdio JSON-RPC plumbing ──────────────────────────────────────────────

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "fleet-mcp", version: "0.1.0" },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") {
    reply(id, {
      tools: Object.entries(TOOLS).map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const tool = TOOLS[name];
    if (!tool) return fail(id, -32602, `unknown tool: ${name}`);
    try {
      const text = await tool.handler(params?.arguments || {});
      reply(id, { content: [{ type: "text", text }] });
    } catch (e) {
      // Tool errors are reported in-band so the model can react, not as protocol errors.
      reply(id, { content: [{ type: "text", text: `ERROR: ${e?.message || e}` }], isError: true });
    }
    return;
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return;
  }
  Promise.resolve(handle(msg)).catch((e) => process.stderr.write(`[fleet-mcp] ${e?.stack || e}\n`));
});
process.stderr.write(`[fleet-mcp] ready; targets=${TARGETS_PATH}\n`);
