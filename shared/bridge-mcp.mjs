// bridge-mcp — tools connecting the agent to the human + the chat. Loaded by the
// per-VM daemon and the AI master (stdio MCP, zero deps). Talks to the local
// agent-bridge on 127.0.0.1:4097 and (on a daemon) reuses the `fleet` CLI.
//
// Tools:
//   ask_human(question)            both roles — ask the user, block for the reply
//   share_file(path, caption, from) both roles — put a file in the chat's outbox
//   screenshot()                   daemon only — capture the VM screen, return it
//                                  as a native image (vision models see it directly)
//   db_schema()                    storage daemon only — GET /db/schema (audited path)
//   db_migrate(name, sql)          storage daemon only — POST /db/migrations: apply
//                                  the SQL transactionally, record it in
//                                  _platform_migrations, best-effort git-commit it
//   search_charts(query, limit?)   in-cluster pods — Helm-chart discovery via
//                                  tenant-api's Artifact Hub proxy (the pod has
//                                  no internet egress; tenant-api does)
//
// Security: these add NO network listener and NO capability the agent doesn't
// already have through `fleet`. The one new risk — share_file reading a pod-local
// file into the user-downloadable outbox — is locked to an allowlist so it can
// never exfiltrate the daemon's secrets (SSH key, vm_password, provider auth.json).
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { readFile, unlink, realpath, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

const BRIDGE = process.env.AGENT_BRIDGE || "http://127.0.0.1:4097";
// The platform API (tenant-api), reachable in-cluster from daemon/master pods
// (a per-pod NetworkPolicy allows egress to tenant-api:8080 — the tenant
// namespace's egress rules exclude private CIDRs otherwise). The tenant name
// derives from the pod's namespace (tenant-<name>) via the serviceaccount
// mount, so no extra env plumbing is needed; both are overridable for dev.
const TENANT_API = process.env.TENANT_API || "http://tenant-api.tenant-api.svc.cluster.local:8080";
// Workspace identity for tenant-api: the chart mounts a projected, audience-
// bound ServiceAccount token (agent-sa) here. tenant-api validates it via
// TokenReview and scopes the caller to this workspace. Re-read per call — the
// kubelet rotates the file; it's tiny. Absent in dev → no header (tenant-api's
// legacy paths still apply there).
const TENANT_API_TOKEN_PATH = process.env.TENANT_API_TOKEN_PATH || "/var/run/secrets/tenant-api/token";
function apiAuthHeaders() {
  try {
    const tok = readFileSync(TENANT_API_TOKEN_PATH, "utf8").trim();
    if (tok) return { authorization: `Bearer ${tok}` };
  } catch {}
  return {};
}
const TENANT = (() => {
  if (process.env.TENANT_NAME) return process.env.TENANT_NAME;
  try {
    const ns = readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/namespace", "utf8").trim();
    if (ns.startsWith("tenant-")) return ns.slice("tenant-".length);
  } catch {}
  return "";
})();
// The local opencode server (same pod) — used to resolve which session is
// executing an ask_human call and to deliver late answers into it.
const OPENCODE = process.env.OPENCODE_BASE || "http://127.0.0.1:4096";
const PROTOCOL_VERSION = "2024-11-05";
// Active block: how long the ask_human tool call itself waits before returning
// the STOP result. Workspace-configurable (TenantSpec ai.askWaitMinutes →
// rendered into the daemon/master Secret as `ask_wait_minutes`, mounted at
// /etc/aidaemon | /etc/aimaster); ASK_WAIT_MINUTES env overrides for dev.
// Clamped 1..60, default 10.
const ASK_WAIT_MINUTES = (() => {
  const parse = (s) => {
    const n = parseInt(String(s ?? "").trim(), 10);
    return Number.isFinite(n) && n >= 1 && n <= 60 ? n : null;
  };
  const fromEnv = parse(process.env.ASK_WAIT_MINUTES);
  if (fromEnv) return fromEnv;
  for (const p of ["/etc/aidaemon/ask_wait_minutes", "/etc/aimaster/ask_wait_minutes"]) {
    try {
      const n = parse(readFileSync(p, "utf8"));
      if (n) return n;
    } catch {}
  }
  return 10;
})();
const ASK_TIMEOUT_MS = ASK_WAIT_MINUTES * 60 * 1000;
// Daemon (has a VM) vs master. The screenshot tool only exists on a daemon.
const IS_DAEMON = existsSync("/etc/aidaemon/vm_user");
// Storage daemon (postgres/redis connection env injected by the chart): the
// deterministic /db/* bridge endpoints exist, so expose the db_* tools.
const HAS_DB = !!(process.env.PGHOST || process.env.REDIS_HOST);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── ask_human answer channels ────────────────────────────────────────────────
// An answer can arrive two ways:
//   1. the bridge: chat dock widget / tenant-api's answer endpoint POST
//      /ask/answer → our /ask/wait long-poll resolves;
//   2. the session: tenant-api's task-answer fallback injects the answer as a
//      USER message into the opencode session (prompt_async).
// The tool watches BOTH. To watch the session it must know WHICH session is
// executing this call — an MCP tool doesn't get told, so we find it: the
// calling session's message list carries a running `ask_human` tool part whose
// input contains our question.

async function sessionMessages(sid) {
  const r = await jfetch(`${OPENCODE}/session/${encodeURIComponent(sid)}/message`, {}, 6000).catch(() => null);
  return Array.isArray(r?.body) ? r.body : null;
}

// A short, JSON-escape-safe needle from the question for input matching.
const questionNeedle = (q) => String(q).replace(/[^a-zA-Z0-9 ]+/g, "").replace(/\s+/g, " ").trim().slice(0, 40);

async function resolveAskSession(question) {
  const needle = questionNeedle(question);
  const r = await jfetch(`${OPENCODE}/session`, {}, 6000).catch(() => null);
  const now = Date.now();
  const candidates = (Array.isArray(r?.body) ? r.body : [])
    .filter((s) => s?.id && now - (s?.time?.updated || 0) < 10 * 60 * 1000)
    .sort((a, b) => (b?.time?.updated || 0) - (a?.time?.updated || 0))
    .slice(0, 16);
  for (const s of candidates) {
    const msgs = await sessionMessages(s.id);
    if (!msgs) continue;
    for (const m of msgs) {
      for (const p of m.parts || []) {
        if (p.type !== "tool" || !p.state) continue;
        if (p.state.status !== "running" && p.state.status !== "pending") continue;
        if (!String(p.tool || "").includes("ask_human")) continue;
        const input = JSON.stringify(p.state.input ?? p.state.args ?? {}).replace(/[^a-zA-Z0-9 ]+/g, "").replace(/\s+/g, " ");
        if (!needle || input.includes(needle)) return { sid: s.id, baseline: msgs.length };
      }
    }
  }
  return null;
}

// A NEW user message that arrived after the ask was posted = the answer
// (tenant-api's task-answer path, or the user typing into the chat).
function newUserAnswer(msgs, baseline) {
  for (let i = baseline; i < msgs.length; i++) {
    const info = msgs[i].info || msgs[i];
    if ((info.role || "") !== "user") continue;
    const text = (msgs[i].parts || []).filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n").trim();
    // tenant-api's task-answer path already prefixes "HUMAN ANSWER: " — strip
    // it so the tool result doesn't double the marker.
    if (text) return text.replace(/^HUMAN ANSWER:\s*/i, "");
  }
  return null;
}

// Mirrors status-server's sessionRunning reduction (is the turn still going?).
function sessionLooksRunning(msgs) {
  let lastRole = "", lastAssistantDone = true, running = false;
  for (const m of Array.isArray(msgs) ? msgs : []) {
    const info = m.info || m;
    lastRole = info.role || lastRole;
    if ((info.role || "") === "assistant") lastAssistantDone = !!info?.time?.completed;
    for (const p of m.parts || [])
      if (p.type === "tool" && p.state && (p.state.status === "running" || p.state.status === "pending")) running = true;
  }
  return running || lastRole === "user" || !lastAssistantDone;
}

function settleBridgeAsk(id, answer) {
  return jfetch(`${BRIDGE}/ask/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, answer }),
  }).catch(() => null);
}

// Deliver a late answer INTO the calling session as a user message (waiting
// for the current turn to end first, like the master-wake path does).
async function injectUserMessage(sid, text) {
  for (let i = 0; i < 60; i++) {
    const msgs = await sessionMessages(sid);
    if (msgs && !sessionLooksRunning(msgs)) break;
    await sleep(5000);
  }
  await jfetch(`${OPENCODE}/session/${encodeURIComponent(sid)}/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text }] }),
  }, 10000).catch(() => null);
}

// After the tool call itself is gone (client cancelled it, or we returned the
// STOP text on timeout), keep watching: a late answer is injected into the
// session so it is never lost; an answer that arrived AS a session message
// just settles the bridge entry. NO time cap — "waiting for a human" can be
// days — the watcher runs until the ask is answered or disappears (404: it
// was abandoned/dismissed or the bridge restarted), backing off from seconds
// to 5-minute polls. Honest caveat: this watcher is in-memory, so a pod
// restart drops it; the durable fallback is the platform-side answer path
// (tenant-api handleAnswerAgentTask → prompt_async into the session), which
// has no timer at all.
async function watchAnswerDetached(id, where) {
  const started = Date.now();
  for (;;) {
    const age = Date.now() - started;
    // Backoff: near-instant for the first 10 min, 30s cadence up to 1h,
    // then one poll every 5 min indefinitely.
    const waitMs = age < 10 * 60 * 1000 ? 4000 : age < 60 * 60 * 1000 ? 25000 : 25000;
    const sleepMs = age < 10 * 60 * 1000 ? 3000 : age < 60 * 60 * 1000 ? 5000 : 5 * 60 * 1000 - 25000;
    const w = await jfetch(`${BRIDGE}/ask/wait?id=${encodeURIComponent(id)}&timeout=${waitMs}`, {}, waitMs + 10000).catch(() => null);
    if (w && w.status === 404) return; // ask gone (abandoned / bridge restarted)
    if (w?.body?.answered) {
      if (where)
        await injectUserMessage(
          where.sid,
          `HUMAN ANSWER: ${w.body.answer}\n\nThis answers your earlier ask_human question (that tool call had already ended). Continue with this answer.`,
        );
      return;
    }
    if (where) {
      const msgs = await sessionMessages(where.sid);
      const ans = msgs && newUserAnswer(msgs, where.baseline);
      if (ans != null) {
        await settleBridgeAsk(id, ans); // already in the session — just settle
        return;
      }
    }
    await sleep(sleepMs);
  }
}

async function askHuman({ question, kind, options }, ctx = {}) {
  if (!question || !String(question).trim()) throw new Error("ask_human requires a non-empty question");
  const created = await jfetch(`${BRIDGE}/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: String(question), kind, options }),
  });
  if (!created.ok || !created.body?.id) throw new Error(`could not post the question (status ${created.status})`);
  const id = created.body.id;
  const where = await resolveAskSession(question).catch(() => null);
  const dupNote =
    "\n\n(Note: this answer may also appear as the next user message in this session — it is the SAME answer, do not treat it as a second instruction.)";
  const deadline = Date.now() + ASK_TIMEOUT_MS;
  let n = 0;
  while (Date.now() < deadline) {
    // The MCP client cancelled this call (its own request timeout): our return
    // value would be dropped, so switch to detached delivery.
    if (ctx.isCancelled?.()) {
      watchAnswerDetached(id, where).catch(() => {});
      return "CANCELLED";
    }
    // Progress notifications reset the client's request timeout when it
    // supports that (MCP resetTimeoutOnProgress); harmless otherwise.
    if (ctx.progressToken !== undefined && ctx.progressToken !== null)
      send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: ctx.progressToken, progress: ++n } });
    const w = await jfetch(`${BRIDGE}/ask/wait?id=${encodeURIComponent(id)}&timeout=2000`, {}, 10000).catch(() => null);
    if (w?.body?.answered) return `HUMAN ANSWER: ${w.body.answer}\n\nProceed accordingly.`;
    if (where) {
      const msgs = await sessionMessages(where.sid);
      const ans = msgs && newUserAnswer(msgs, where.baseline);
      if (ans != null) {
        await settleBridgeAsk(id, ans); // stop the pending-ask surfacing
        return `HUMAN ANSWER: ${ans}\n\nProceed accordingly.${dupNote}`;
      }
    }
    await sleep(600);
  }
  // No answer inside the active window. Keep watching in the background (a
  // late answer gets injected as a user message) and make the model STOP.
  watchAnswerDetached(id, where).catch(() => {});
  return (
    `NO ANSWER YET after ${ASK_WAIT_MINUTES} minutes. STOP NOW: end your turn without taking ANY further action. ` +
    "The question stays open — the human's answer (even days later) will arrive as a new message " +
    "and you will continue then. Acting without the answer is a policy violation."
  );
}

// Hand a file to the bridge, which files it under the ACTIVE session's outbox
// (the chat then shows it inline in that session). The bridge knows the session;
// the MCP tool can't.
async function postOutbox(name, b64, caption) {
  const r = await jfetch(`${BRIDGE}/outbox`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, data: b64, caption: caption || "" }),
  });
  if (!r.ok) throw new Error(`could not share the file (status ${r.status})`);
}

async function shareFile({ path, caption, from }) {
  if (!path) throw new Error("share_file requires { path }");
  const name = basename(String(path)) || "file";
  let b64;
  if (from === "vm") {
    if (!IS_DAEMON) throw new Error("from:'vm' is only available on a VM daemon");
    const tmp = `/tmp/mcp-share-${Date.now()}-${name}`;
    await run("fleet", ["pull", "vm", String(path), tmp]); // from the user's own VM
    b64 = (await readFile(tmp)).toString("base64");
    await unlink(tmp).catch(() => {});
  } else {
    // Local pod file: must resolve inside the allowlist (blocks secrets/keys).
    let real;
    try { real = await realpath(String(path)); } catch { throw new Error(`no such file: ${path}`); }
    if (!SHARE_ROOTS.some((root) => real === root || real.startsWith(root + "/")))
      throw new Error("share_file (local) only allows files under /workspace or /tmp");
    if (!(await stat(real)).isFile()) throw new Error("not a regular file");
    b64 = (await readFile(real)).toString("base64");
  }
  await postOutbox(name, b64, caption);
  return `Shared "${name}" with the user — it's in the chat's attachments.${caption ? ` (${caption})` : ""}`;
}

async function screenshot() {
  if (!IS_DAEMON) throw new Error("screenshot is only available on a VM daemon");
  const tmp = `/tmp/mcp-screen-${Date.now()}.png`;
  // Reuse the fleet CLI (cua /cmd over SSH + decode) — same capability the agent
  // already has; this just returns the bytes as a native image to the model.
  await run("fleet", ["screenshot", "vm", tmp], 60000);
  const b64 = (await readFile(tmp)).toString("base64");
  await unlink(tmp).catch(() => {});
  await postOutbox("screen.png", b64, "screenshot").catch(() => {}); // so the user sees it inline
  return {
    content: [
      { type: "text", text: "Screenshot of the VM (also shown in the chat). If your model is text-only, run analyze_image on /workspace/inbox or ask for a vision model." },
      { type: "image", data: b64, mimeType: "image/png" },
    ],
  };
}

// ── DB admin (storage daemon): call the bridge's audited /db/* endpoints ─────
// Same deterministic path the platform uses — never hand-roll psql for schema
// changes, so every migration lands in _platform_migrations + git.
async function dbSchema() {
  const r = await jfetch(`${BRIDGE}/db/schema`, {}, 30000);
  if (!r.ok) throw new Error(`schema fetch failed (status ${r.status}): ${JSON.stringify(r.body).slice(0, 500)}`);
  return JSON.stringify(r.body, null, 2);
}

async function dbMigrate({ name, sql }) {
  if (!name || !String(name).trim()) throw new Error("db_migrate requires a non-empty name");
  if (!sql || !String(sql).trim()) throw new Error("db_migrate requires non-empty sql");
  const r = await jfetch(`${BRIDGE}/db/migrations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: String(name), sql: String(sql) }),
  }, 120000);
  if (!r.ok) {
    const detail = r.body?.detail || r.body?.error || JSON.stringify(r.body);
    throw new Error(`migration NOT applied (status ${r.status}): ${String(detail).slice(0, 800)}`);
  }
  return `Migration applied: version ${r.body?.version} ("${name}"). Git: ${r.body?.git || "unknown"}.`;
}

// ── Chart discovery: tenant-api's Artifact Hub proxy ─────────────────────────
// The pod can't reach the internet, so discovery goes through the platform API
// (which can). Read-only; returns chart metadata the model uses to pick the
// app's official image — nothing is installed.
async function searchCharts({ query, limit }) {
  if (!query || !String(query).trim()) throw new Error("search_charts requires a non-empty query");
  const n = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 10);
  const u = `${TENANT_API}/v1/tenants/${encodeURIComponent(TENANT)}/charts/search` +
    `?q=${encodeURIComponent(String(query).trim())}&limit=${n}`;
  // 15s: tenant-api itself caps the upstream Artifact Hub call at 10s.
  const r = await jfetch(u, { headers: apiAuthHeaders() }, 15000);
  if (!r.ok) {
    const detail = r.body?.error || JSON.stringify(r.body);
    throw new Error(`chart search failed (status ${r.status}): ${String(detail).slice(0, 400)}`);
  }
  const charts = r.body?.charts || [];
  if (!charts.length)
    return `No charts found for "${query}" — try the app's plain name or a broader term.`;
  return JSON.stringify(charts, null, 2);
}

const TOOLS = {
  ask_human: {
    description:
      "Ask the human user a question and WAIT for their reply. Use for decisions, " +
      "missing info, credentials, or confirmation before something risky. The call " +
      `BLOCKS until the answer arrives (up to ~${ASK_WAIT_MINUTES} min) and returns their exact words. ` +
      "HARD RULE: take NO further action until you have the answer. If it returns " +
      "NO ANSWER YET (or the call errors/times out), STOP and end your turn " +
      "immediately — the question stays open and the answer (even days later) arrives " +
      "as a new message; you continue then. Never perform destructive or irreversible " +
      "actions between asking and receiving the answer.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "what to ask the user" },
        kind: {
          type: "string",
          enum: ["input", "approve", "choose", "captcha"],
          description: "input=free text (default); approve=yes/no confirmation before something risky; choose=pick one of `options`; captcha=a human must act in the live browser/VNC",
        },
        options: { type: "array", items: { type: "string" }, description: "for kind=choose: 2-8 choices" },
      },
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

if (HAS_DB) {
  TOOLS.db_schema = {
    description:
      "Get the database schema (tables, columns, indexes, row estimates) as JSON " +
      "via the bridge's deterministic /db/schema endpoint. Postgres only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: dbSchema,
  };
  TOOLS.db_migrate = {
    description:
      "Apply a schema migration through the platform's audited path: the SQL runs " +
      "in ONE transaction, is recorded in _platform_migrations, and is committed to " +
      "the migrations git repo. ALWAYS use this for schema changes instead of raw " +
      "psql, so the schema history stays replayable. On failure nothing is applied.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "short human title, e.g. 'add orders index'" },
        sql: { type: "string", description: "the migration SQL (max 256KB)" },
      },
      required: ["name", "sql"],
      additionalProperties: false,
    },
    handler: dbMigrate,
  };
}

// Chart discovery is only meaningful (and only routable) from an in-cluster
// tenant pod — TENANT resolves there from the pod's namespace.
if (TENANT) {
  TOOLS.search_charts = {
    description:
      "Search Helm charts (Artifact Hub, proxied by the platform) to DISCOVER how " +
      "a known app ships: name, repository, repoUrl, version, appVersion, " +
      "description, stars, official. Use it when asked to deploy an existing app " +
      "you don't know the image for; then run `helm show values <name> --repo " +
      "<repoUrl>` READ-ONLY to learn its image/env/port and wrap that official " +
      "image in a Dockerfile — never install the chart itself.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "the app to look for, e.g. 'nextcloud' or 'workflow automation'" },
        limit: { type: "integer", minimum: 1, maximum: 10, description: "max results (default 5)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: searchCharts,
  };
}

// ── MCP stdio JSON-RPC plumbing ──────────────────────────────────────────────
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const toContent = (r) => (r && typeof r === "object" && Array.isArray(r.content) ? r : { content: [{ type: "text", text: String(r) }] });

// Requests the client cancelled mid-flight (notifications/cancelled). A
// blocking tool (ask_human) checks this so it can switch to detached answer
// delivery — its return value would be dropped anyway.
const cancelledRequests = new Set();

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize")
    return reply(id, {
      protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "bridge-mcp", version: "0.3.0" },
    });
  if (method === "notifications/cancelled") {
    if (params?.requestId !== undefined) cancelledRequests.add(params.requestId);
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list")
    return reply(id, {
      tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
    });
  if (method === "tools/call") {
    const tool = TOOLS[params?.name];
    if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
    const ctx = {
      requestId: id,
      progressToken: params?._meta?.progressToken,
      isCancelled: () => cancelledRequests.has(id),
    };
    try {
      const out = await tool.handler(params?.arguments || {}, ctx);
      return reply(id, toContent(out));
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: `ERROR: ${e?.message || e}` }], isError: true });
    } finally {
      cancelledRequests.delete(id);
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
