// agent-bridge — the AI daemon/master's local HTTP server on :4097.
//
//   GET  /status                 guest status (daemon): SSH key-auth/cloud-init/cua.
//                                master returns minimal {online:true}.
//   POST /session/active         { session } — the chat tells us which session is
//                                active, so files an MCP tool writes get scoped to it
//                                (tools can't know their own opencode session).
//   GET  /outbox?session=<id>    files the agent shared in that session
//   GET  /outbox/<id>/<name>     fetch one
//   DELETE /outbox/<id>/<name>   remove one (chat "remove" button)
//   POST /outbox                 { name, data, caption } — an MCP tool shares a file
//                                into the ACTIVE session's outbox
//   POST /inbox                  { name, data, session } — a user attachment, saved
//                                so the agent can open it
//   GET  /ask | POST /ask | GET /ask/wait | POST /ask/answer   — ask_human (global)
//   /db/*                        deterministic DB admin on storage daemons
//                                (psql/redis-cli via the pod's connection env;
//                                no LLM in the loop — see db-admin.mjs)
//
// Attachments are per-session dirs (outbox/<session>, inbox/<session>); another
// session can still read them by path on disk.
import http from "node:http";
import os from "node:os";
import { execFile } from "node:child_process";
import { readFile, readdir, stat, mkdir, unlink, writeFile, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, basename, extname } from "node:path";
import * as db from "./db-admin.mjs";

const PORT = 4097;
const OUTBOX = process.env.AGENT_OUTBOX || "/workspace/outbox";
const INBOX = process.env.AGENT_INBOX || "/workspace/inbox";
const IS_DAEMON = await readFile("/etc/aidaemon/vm_user", "utf8").then(() => true).catch(() => false);
const GUI = await readFile("/etc/aidaemon/vm_gui", "utf8").then((s) => s.trim() === "true").catch(() => false);
const OPENCODE = process.env.OPENCODE_BASE || "http://127.0.0.1:4096";

// ── busy PUSH to tenant-api (Phase 2 of the realtime rewrite) ─────────────────
// This process shares the opencode container, so it can subscribe to opencode's
// own /event SSE and POST busy-state TRANSITIONS to tenant-api's per-workspace
// hub — turning the workspace "is this agent working?" dot into a push instead
// of a browser poll. The /busy endpoint below stays the pulse fallback.
//
// Auth + identity mirror bridge-mcp.mjs: the chart mounts an audience-bound
// agent-sa token (Authorization: Bearer) and TENANT derives from the pod
// namespace (tenant-<name>). tenant-api's ownedTenant accepts the agent-sa.
const TENANT_API = process.env.TENANT_API || "http://tenant-api.tenant-api.svc.cluster.local:8080";
const TENANT_API_TOKEN_PATH = process.env.TENANT_API_TOKEN_PATH || "/var/run/secrets/tenant-api/token";
async function apiAuthHeaders() {
  try {
    const tok = (await readFile(TENANT_API_TOKEN_PATH, "utf8")).trim();
    if (tok) return { authorization: `Bearer ${tok}` };
  } catch {}
  return {};
}
const TENANT = await (async () => {
  if (process.env.TENANT_NAME) return process.env.TENANT_NAME;
  try {
    const ns = (await readFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace", "utf8")).trim();
    if (ns.startsWith("tenant-")) return ns.slice("tenant-".length);
  } catch {}
  return "";
})();
// This pod's own agent id, from the pod name (os.hostname() = the pod name for a
// Deployment):  <tenant>-<id>-aidaemon-<rs>-<pod>  |  <tenant>-<id>-aimaster-…
// tenant-api forms the hub key ("daemon:<id>"/"master:<id>") from the CR, so we
// only need {id} for the URL. Robust against dashes in the id: strip the known
// TENANT prefix, then cut at the fixed role token.
const SELF_ID = (() => {
  let host = os.hostname();
  if (TENANT && host.startsWith(TENANT + "-")) host = host.slice(TENANT.length + 1);
  for (const tok of ["-aidaemon", "-aimaster"]) {
    const at = host.indexOf(tok);
    if (at > 0) return host.slice(0, at);
  }
  return "";
})();

await mkdir(OUTBOX, { recursive: true }).catch(() => {});
await mkdir(INBOX, { recursive: true }).catch(() => {});

// Which opencode session is in front right now (set by the chat). MCP tools
// write to this session's outbox. Defaults so a stray write isn't lost.
let activeSession = "default";
const sess = (s) => (s ? basename(String(s)) : activeSession) || "default";
const outDir = (s) => join(OUTBOX, sess(s));
const inDir = (s) => join(INBOX, sess(s));

// ── daemon guest status (unchanged) ──────────────────────────────────────────
function sh(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => resolve({ ok: !err, out: (stdout || "").trim() }));
  });
}
const ssh = (remote) => sh("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "vm", remote]);
async function probe() {
  if (!IS_DAEMON) return { online: true, master: true, ts: Date.now() };
  const sshOk = (await ssh("true")).ok;
  let cloudInit = "unknown", cuaInstalled = false, cuaActive = false;
  if (sshOk) {
    cloudInit = (await ssh("cloud-init status 2>/dev/null | sed -n 's/^status: //p'")).out || "done";
    if (GUI) {
      cuaInstalled =
        (await ssh("command -v cua-computer-server >/dev/null 2>&1 || ls ~/.local/bin/cua-computer-server >/dev/null 2>&1; echo $?")).out === "0";
      cuaActive = (await ssh("systemctl is-active cua-computer-server 2>/dev/null")).out === "active";
    }
  }
  const bootstrapStatus = await readFile("/tmp/agent-bootstrap.status", "utf8").then((s) => s.trim()).catch(() => "");
  const bootstrapTail = await readFile("/tmp/agent-bootstrap.log", "utf8")
    .then((s) => s.trim().split("\n").slice(-3).join("\n")).catch(() => "");
  return { gui: GUI, sshOk, cloudInit, cuaInstalled, cuaActive, bootstrapStatus, bootstrapTail, ts: Date.now() };
}
let cache = null, cacheAt = 0, inflight = null;
function getStatus() {
  if (cache && Date.now() - cacheAt < 4000) return Promise.resolve(cache);
  if (!inflight) {
    inflight = probe()
      .then((r) => { cache = r; cacheAt = Date.now(); inflight = null; return r; })
      .catch(() => { inflight = null; return cache ?? { online: false }; });
  }
  return inflight;
}

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf",
  ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
  ".csv": "text/csv", ".log": "text/plain", ".html": "text/html",
};
const mimeOf = (name) => MIME[extname(name).toLowerCase()] || "application/octet-stream";

async function listOutbox(session) {
  const dir = outDir(session);
  const names = await readdir(dir).catch(() => []);
  const captions = await readFile(join(dir, ".captions.json"), "utf8").then((s) => JSON.parse(s)).catch(() => ({}));
  const out = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const st = await stat(join(dir, name)).catch(() => null);
    if (!st || !st.isFile()) continue;
    out.push({ name, size: st.size, mime: mimeOf(name), mtime: st.mtimeMs, caption: captions[name] || "" });
  }
  out.sort((a, b) => a.mtime - b.mtime); // chronological — they render inline in order
  return out;
}
async function writeOutbox(session, name, b64, caption) {
  const dir = outDir(session);
  await mkdir(dir, { recursive: true }).catch(() => {});
  const safe = basename(name);
  await writeFile(join(dir, safe), Buffer.from(String(b64).replace(/^data:[^;]*;base64,/, ""), "base64"));
  if (caption) {
    const cf = join(dir, ".captions.json");
    const map = await readFile(cf, "utf8").then((s) => JSON.parse(s)).catch(() => ({}));
    map[safe] = String(caption);
    await writeFile(cf, JSON.stringify(map)).catch(() => {});
  }
  return join(dir, safe);
}

// ── busy probe: which sessions are running a task right now? ──────────────────
// The chat marks a session-dot green only when that exact session is running, so
// we must report EVERY running session (a master can drive several in parallel),
// not just the most-recent one. We also return each running session's title so
// the graph can annotate the master→agent edge with the task in flight.
//
// Cost control: a session that hasn't been touched in a while can't be running,
// so we only inspect sessions updated within ACTIVE_WINDOW (and cap the count).
// Running sessions stream updates continuously, so they always stay in-window.
let busyCache = null, busyAt = 0;
const ACTIVE_WINDOW = 10 * 60 * 1000; // 10 min
const MAX_PROBE = 16;
async function sessionRunning(sid) {
  try {
    // Bounded: a long session's message list can be MBs and take seconds to
    // serialize — never let one slow probe hold the whole /busy sweep.
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 3000);
    const mres = await fetch(`http://127.0.0.1:4096/session/${sid}/message`, { signal: ac.signal });
    clearTimeout(t);
    const msgs = await mres.json();
    let lastRole = "", lastAssistantDone = true, running = false;
    for (const m of Array.isArray(msgs) ? msgs : []) {
      const info = m.info || m;
      lastRole = info.role || lastRole;
      if ((info.role || "") === "assistant") lastAssistantDone = !!info?.time?.completed;
      for (const p of m.parts || [])
        if (p.type === "tool" && p.state && (p.state.status === "running" || p.state.status === "pending")) running = true;
    }
    return running || lastRole === "user" || !lastAssistantDone;
  } catch {
    return false;
  }
}
// Stale-while-revalidate: /busy is polled every ~5s per open chat, and a
// fresh sweep costs up to seconds (opencode serializes each candidate
// session's full message list). Serving the last snapshot instantly and
// refreshing in the background keeps the UI at ~0ms; a blinking dot may lag
// reality by one poll, which is invisible.
let busyRefreshing = null;
async function busy() {
  const stale = !busyCache || Date.now() - busyAt >= 2500;
  if (stale && !busyRefreshing) {
    busyRefreshing = busySweep().finally(() => (busyRefreshing = null));
  }
  if (busyCache) return busyCache; // instant (possibly one poll stale)
  return busyRefreshing; // first call ever: nothing cached yet, wait once
}
async function busySweep() {
  let out = { busy: false, session: null, sessions: [], tasks: {} };
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 6000);
    const sres = await fetch("http://127.0.0.1:4096/session", { signal: ac.signal });
    const sessions = await sres.json();
    clearTimeout(t);
    const list = (Array.isArray(sessions) ? sessions : []).sort(
      (a, b) => (b?.time?.updated || 0) - (a?.time?.updated || 0),
    );
    const now = Date.now();
    const candidates = list
      .filter((s) => s?.id && now - (s?.time?.updated || 0) < ACTIVE_WINDOW)
      .slice(0, MAX_PROBE);
    const running = [];
    const tasks = {};
    await Promise.all(
      candidates.map(async (s) => {
        if (await sessionRunning(s.id)) {
          running.push(s.id);
          tasks[s.id] = (s.title || "").trim();
        }
      }),
    );
    // back-compat `session`: most-recently-updated running one (candidates are
    // already sorted desc), else the latest session overall.
    const runSet = new Set(running);
    const newestRunning = candidates.find((s) => runSet.has(s.id))?.id;
    out = {
      busy: running.length > 0,
      session: newestRunning || list[0]?.id || null,
      sessions: running,
      tasks,
    };
  } catch {
    /* opencode busy/unreachable → report not busy */
  }
  busyCache = out;
  busyAt = Date.now();
  return out;
}

// POST the current busy state to tenant-api's hub. Best-effort: if tenant-api is
// unreachable we just skip — the /pulse in-cluster probe still covers it.
async function postBusy(b) {
  if (!TENANT || !SELF_ID) return;
  const url = `${TENANT_API}/v1/tenants/${encodeURIComponent(TENANT)}/workloads/${encodeURIComponent(SELF_ID)}/agent-busy`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await apiAuthHeaders()) },
      body: JSON.stringify({ busy: b.busy, sessions: b.sessions || [], tasks: b.tasks || {} }),
      signal: ac.signal,
    });
  } catch {
    /* tenant-api unreachable — pulse fallback covers it */
  } finally {
    clearTimeout(t);
  }
}

// Debounced busy-transition detector. opencode's /event SSE fires many frames
// per turn; coalesce them into at most one fresh busySweep per 500ms, and POST
// only when the boolean actually FLIPPED (lastBusy seeds false = idle at boot,
// so a daemon that boots into a running task announces the going-busy edge).
let lastBusy = false;
let busyTimer = null;
function scheduleBusyCheck() {
  if (busyTimer) return; // already coalescing this window
  busyTimer = setTimeout(async () => {
    busyTimer = null;
    let b;
    try {
      b = await busySweep(); // fresh sweep (also refreshes the /busy cache)
    } catch {
      return;
    }
    if (!b || b.busy === lastBusy) return; // no transition → no POST
    lastBusy = b.busy;
    postBusy(b);
  }, 500);
}

// Only session/message lifecycle frames can change the busy boolean; skip the
// rest (permission/file/server noise) so we don't sweep needlessly. Heartbeat /
// comment-only frames carry no data: line.
function busyRelevantFrame(frame) {
  if (!frame.includes("data:")) return false;
  return frame.includes("session") || frame.includes("message");
}

// Subscribe to opencode's own SSE event stream and drive the transition
// detector. Reconnects with capped exponential backoff if the stream drops
// (opencode restart, pod roll); a fresh connect re-seeds the baseline.
async function streamOpencodeEvents() {
  let backoff = 1000;
  for (;;) {
    try {
      const res = await fetch(`${OPENCODE}/event`, { headers: { accept: "text/event-stream" } });
      if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`);
      backoff = 1000; // healthy connect resets the backoff
      scheduleBusyCheck(); // seed the baseline on (re)connect
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (busyRelevantFrame(frame)) scheduleBusyCheck();
        }
      }
    } catch {
      /* fall through to reconnect */
    }
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 30000);
  }
}
// Push is in-cluster only: no TENANT/id (dev/standalone engine) → skip and let
// the pulse probe be the sole busy source.
if (TENANT && SELF_ID) streamOpencodeEvents();

// ── delegated-agent watches (master only): wake the master on completion ──────
// When the master delegates a task, fleet-mcp POSTs /watch here. We poll the
// slave's session and, when it finishes (or errors / blocks on a human / stalls),
// we inject a USER message into the MASTER's OWN opencode session via
// /session/<id>/prompt_async — so the master is re-prompted to evaluate the
// result even though it already ended its turn. This replaces the old blocking
// await_agent (a 20-min tool call that hung / showed as broken). The session we
// wake is whatever was active when the watch was registered (the master's chat).
const watches = new Map();
let watchSeq = 0;
const WATCH_MAX_MS = 30 * 60 * 1000; // give up (call it "stuck") after this
const WATCH_POLL_MS = 5000;
const WATCH_MAX_FAILS = 60; // ~5 min of unreachable slave -> "broken"

async function fetchJson(url, opts, timeoutMs = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    const text = await r.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { ok: r.ok, status: r.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

// Reduce a slave's message list to {done, text, error}. "done" means the last
// assistant message finished AND no tool is still running.
function inspectSession(msgs) {
  let last = null, running = false;
  for (const m of Array.isArray(msgs) ? msgs : []) {
    const info = m.info || m;
    if ((info.role || "") === "assistant") last = m;
    for (const p of m.parts || [])
      if (p.type === "tool" && p.state && (p.state.status === "running" || p.state.status === "pending")) running = true;
  }
  if (!last) return { done: false, text: "", error: null };
  const info = last.info || last;
  const text = (last.parts || []).filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n").trim();
  const error = info?.error ? (info.error.message || info.error.name || JSON.stringify(info.error)) : null;
  return { done: !!info?.time?.completed && !running, text, error };
}

// Inject a user message into the master's own session. Skip while that session
// is already running so we never interrupt the master mid-turn or race two wakes
// — we just retry on the next tick. Returns true only if the message landed.
async function wakeMaster(masterSession, text) {
  if (await sessionRunning(masterSession)) return false;
  const r = await fetchJson(
    `http://127.0.0.1:4096/session/${encodeURIComponent(masterSession)}/prompt_async`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: [{ type: "text", text }] }) },
  );
  return r.ok;
}

// Returns true if it injected a wake this pass (so the caller stops for this tick
// — one wake at a time, to let the master actually start before the next).
async function processWatch(w) {
  // 0) Pending plan/step review? The agent is BLOCKED waiting for the master to
  // sign off — wake the master to approve/revise (one wake per distinct review).
  const rev = await fetchJson(`${w.slaveBridge}/review?session=${encodeURIComponent(w.session)}`);
  const pr = rev.body?.pending;
  if (pr && w.lastReview !== pr.id) {
    const woke = await wakeMaster(
      w.masterSession,
      `[fleet-review] Agent "${w.agent}" needs your sign-off on its ${pr.kind} before it continues (task: "${w.task}").\n\n` +
        `Its ${pr.kind === "plan" ? "plan" : "progress so far"}:\n${pr.content}\n\n` +
        `It is BLOCKED waiting on you — answer now:\n` +
        `• approve → review_agent({ agent: "${w.agent}", session: "${w.session}", decision: "approve" })\n` +
        `• send back → review_agent({ agent: "${w.agent}", session: "${w.session}", decision: "revise", feedback: "<precise changes>" })`,
    );
    if (woke) { w.lastReview = pr.id; return true; }
    return false;
  }

  // 1) Blocked on a human? Wake once per distinct question so the master relays.
  const ask = await fetchJson(`${w.slaveBridge}/ask`);
  const q = ask.body?.pending?.question;
  if (q && w.lastAsk !== q) {
    const woke = await wakeMaster(
      w.masterSession,
      `[fleet] Agent "${w.agent}" is BLOCKED waiting on a human while doing the task you delegated ("${w.task}").\n` +
        `It asked: "${q}"\n\n` +
        `Relay it to the user with ask_human and pass the reply via answer_agent({ agent: "${w.agent}", answer }), ` +
        `or answer it yourself with answer_agent if you're permitted to decide. You'll be notified again when it finishes.`,
    );
    if (woke) { w.lastAsk = q; return true; }
    return false;
  }

  // 2) Finished (or ended on an error)?
  const r = await fetchJson(`${w.slaveBase}/session/${encodeURIComponent(w.session)}/message`);
  if (r.ok) {
    w.fails = 0;
    const s = inspectSession(r.body);
    if (s.done) {
      let text;
      if (s.error) {
        text =
          `[fleet] Agent "${w.agent}" ENDED WITH AN ERROR on the task you delegated ("${w.task}"):\n${s.error}\n\n` +
          `Decide how to handle it — re-delegate, or tell the user what failed.`;
      } else {
        const ob = await fetchJson(`${w.slaveBridge}/outbox`);
        const files = (ob.body?.files || []).map((f) => f.name);
        text =
          `[fleet] Agent "${w.agent}" FINISHED the task you delegated ("${w.task}").\n\nIts result:\n${s.text || "(no text output)"}` +
          (files.length ? `\n\nIt shared files: ${files.join(", ")} — surface any with collect_file({ agent: "${w.agent}", name }).` : "") +
          `\n\nEvaluate this and continue: aggregate it for the user, delegate follow-up work, or report back. ` +
          `(You were woken automatically — you did not need to wait.)`;
      }
      if (await wakeMaster(w.masterSession, text)) { watches.delete(w.id); return true; }
      return false; // master busy — retry next tick
    }
  } else {
    w.fails = (w.fails || 0) + 1;
  }

  // 3) Stalled or its daemon went unreachable — notify once and give up.
  if (Date.now() - w.startedAt > WATCH_MAX_MS || w.fails > WATCH_MAX_FAILS) {
    const reason = w.fails > WATCH_MAX_FAILS ? "its daemon has been unreachable for several minutes" : "it produced no result for 30 min and may be stuck";
    await wakeMaster(
      w.masterSession,
      `[fleet] Agent "${w.agent}" did NOT finish the task you delegated ("${w.task}") — ${reason}.\n\n` +
        `Look with check({ agent: "${w.agent}", session: "${w.session}" }), re-delegate, or tell the user.`,
    );
    watches.delete(w.id); // give up regardless of whether the wake landed
    return true;
  }
  return false;
}

let watchBusy = false;
async function watchTick() {
  if (watchBusy || watches.size === 0) return;
  watchBusy = true;
  try {
    for (const w of [...watches.values()]) {
      if (await processWatch(w).catch(() => false)) break; // one wake per tick
    }
  } finally {
    watchBusy = false;
  }
}
if (!IS_DAEMON) setInterval(watchTick, WATCH_POLL_MS); // masters only

// ── master supervision: supervised sessions + plan/step review broker ─────────
// A session the master delegated is "supervised": the supervise plugin gates it
// on master approval after each todo update. Reviews are a SEPARATE channel from
// ask_human — the master always decides a review itself (it never relays a review
// to the human). The master's watch poller pulls pending reviews and answers via
// the fleet review_agent tool; the supervise plugin long-polls /review/wait.
const supervised = new Set();
const reviews = new Map(); // id -> { session, kind, content, decision, feedback, ts }
let reviewSeq = 0;
const lastTodos = new Map(); // session -> last todo array (to classify plan vs step)

const fmtTodos = (todos) =>
  todos
    .map((t) => `${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]"} ${String(t.content || "").trim()}`)
    .join("\n");
// First todowrite for a session = the plan; a later one whose completed-count
// grew = a step just finished; otherwise the plan was revised/expanded.
function classifyTodos(session, todos) {
  const prev = lastTodos.get(session);
  lastTodos.set(session, todos);
  if (!prev) return "plan";
  const done = (a) => a.filter((t) => t.status === "completed").length;
  return done(todos) > done(prev) ? "step" : "plan";
}
const pendingReview = (session) => {
  for (const [id, r] of reviews)
    if (r.decision === undefined && (!session || r.session === session))
      return { id, session: r.session, kind: r.kind, content: r.content };
  return null;
};

// ── ask-human (global; transient) ────────────────────────────────────────────
const asks = new Map();
let askSeq = 0;
const pendingAsk = () => {
  for (const [id, a] of asks)
    if (a.answer === undefined) return { id, question: a.question, kind: a.kind, options: a.options, ts: a.ts };
  return null;
};

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}
const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
};

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    try {
      if (p === "/status" || p === "/" || p === "/healthz") return json(res, 200, await getStatus());
      if (p === "/busy" && req.method === "GET") return json(res, 200, await busy());

      if (p === "/session/active" && req.method === "POST") {
        const { session } = await readBody(req);
        if (session) activeSession = basename(String(session));
        return json(res, 200, { ok: true, active: activeSession });
      }

      // fleet-mcp's delegate() registers a watch so we wake the master when the
      // delegated agent finishes. masterSession = whoever is active right now
      // (the master chat that ran delegate). Master-side only.
      if (p === "/watch" && req.method === "POST") {
        const { slaveBase, slaveBridge, session, agent, task } = await readBody(req);
        if (!slaveBase || !session) return json(res, 400, { error: "slaveBase and session required" });
        const id = `w${++watchSeq}`;
        watches.set(id, {
          id,
          slaveBase: String(slaveBase).replace(/\/+$/, ""),
          slaveBridge: String(slaveBridge || "").replace(/\/+$/, ""),
          session: String(session),
          agent: String(agent || "agent"),
          task: String(task || "").replace(/\s+/g, " ").trim().slice(0, 200),
          masterSession: activeSession,
          startedAt: Date.now(),
          fails: 0,
          lastAsk: null,
          lastReview: null,
        });
        return json(res, 200, { ok: true, id, masterSession: activeSession });
      }

      // ── master supervision (plan/step review) ──
      // delegate() marks the new daemon session supervised; the supervise plugin
      // asks /supervised before gating; it submits each todowrite to /review and
      // long-polls /review/wait; the master answers via /review/answer.
      if (p === "/supervise" && req.method === "POST") {
        const { session } = await readBody(req);
        if (session) supervised.add(basename(String(session)));
        return json(res, 200, { ok: true });
      }
      if (p === "/supervised" && req.method === "GET") {
        const s = u.searchParams.get("session");
        return json(res, 200, { supervised: s ? supervised.has(basename(String(s))) : false });
      }
      if (p === "/review" && req.method === "POST") {
        const { session, todos } = await readBody(req);
        if (!session || !Array.isArray(todos)) return json(res, 400, { error: "session and todos required" });
        const sid = basename(String(session));
        const kind = classifyTodos(sid, todos);
        const id = `rv${++reviewSeq}`;
        reviews.set(id, { session: sid, kind, content: fmtTodos(todos), decision: undefined, feedback: "", ts: Date.now() });
        return json(res, 200, { ok: true, id, kind });
      }
      if (p === "/review" && req.method === "GET")
        return json(res, 200, { pending: pendingReview(u.searchParams.get("session")) });
      if (p === "/review/wait" && req.method === "GET") {
        const id = u.searchParams.get("id");
        const r = reviews.get(id);
        if (!r) return json(res, 404, { error: "unknown id" });
        const deadline = Date.now() + 10 * 60 * 1000; // fail-open so a silent master can't deadlock the agent
        const tick = () => {
          const cur = reviews.get(id);
          if (cur && cur.decision !== undefined) { reviews.delete(id); return json(res, 200, { decision: cur.decision, feedback: cur.feedback }); }
          if (Date.now() > deadline) { reviews.delete(id); return json(res, 200, { timeout: true }); }
          setTimeout(tick, 500);
        };
        return tick();
      }
      if (p === "/review/answer" && req.method === "POST") {
        const { id, decision, feedback } = await readBody(req);
        const r = reviews.get(id);
        if (!r) return json(res, 404, { error: "unknown id" });
        r.decision = decision === "revise" ? "revise" : "approve";
        r.feedback = String(feedback || "");
        return json(res, 200, { ok: true });
      }

      if (p === "/outbox" && req.method === "GET")
        return json(res, 200, { files: await listOutbox(u.searchParams.get("session")) });
      // /outbox/<session>/<name>  or  /outbox/<name> (then the active session)
      if (p.startsWith("/outbox/")) {
        const segs = p.slice("/outbox/".length).split("/").filter(Boolean).map(decodeURIComponent);
        const session = segs.length >= 2 ? segs[0] : activeSession;
        const name = basename(segs.length >= 2 ? segs.slice(1).join("/") : segs[0] || "");
        const full = join(OUTBOX, sess(session), name);
        if (req.method === "DELETE") {
          await unlink(full).catch(() => {});
          return json(res, 200, { ok: true });
        }
        const st = await stat(full).catch(() => null);
        if (!st || !st.isFile()) return json(res, 404, { error: "not found" });
        res.writeHead(200, { "content-type": mimeOf(name), "content-length": st.size, "cache-control": "no-store" });
        return createReadStream(full).pipe(res);
      }
      if (p === "/outbox" && req.method === "POST") {
        const { name, data, caption, session } = await readBody(req);
        if (!name || !data) return json(res, 400, { error: "name and data required" });
        const path = await writeOutbox(session || activeSession, name, data, caption);
        return json(res, 200, { ok: true, path, session: sess(session) });
      }

      if (p === "/inbox" && req.method === "POST") {
        const { name, data, session } = await readBody(req);
        if (!name || !data) return json(res, 400, { error: "name and data required" });
        const dir = inDir(session);
        await mkdir(dir, { recursive: true }).catch(() => {});
        const safe = basename(String(name));
        await writeFile(join(dir, safe), Buffer.from(String(data).replace(/^data:[^;]*;base64,/, ""), "base64"));
        return json(res, 200, { ok: true, path: join(dir, safe) });
      }

      // ── deterministic DB admin (storage daemons) ──
      // Shells out to psql/redis-cli with the pod's connection env; handlers
      // live in db-admin.mjs and return { status, body } for this thin map.
      if (p === "/db" || p.startsWith("/db/")) {
        if (!db.engine()) return json(res, 503, { error: "no database configured" });
        let r;
        if (p === "/db/overview" && req.method === "GET") r = await db.overview();
        else if (p === "/db/schema" && req.method === "GET") r = await db.schema(u.searchParams.get("database") || "");
        else if (p === "/db/users" && req.method === "GET") r = await db.listUsers();
        else if (p === "/db/users" && req.method === "POST") r = await db.createUser(await readBody(req));
        else if (p.startsWith("/db/users/") && req.method === "DELETE")
          r = await db.deleteUser(decodeURIComponent(p.slice("/db/users/".length)));
        else if (p === "/db/migrations" && req.method === "GET") r = await db.listMigrations();
        else if (p === "/db/migrations" && req.method === "POST") r = await db.applyMigration(await readBody(req));
        if (r) return json(res, r.status, r.body);
        return json(res, 404, { error: "unknown /db endpoint" });
      }

      if (p === "/ask" && req.method === "GET") return json(res, 200, { pending: pendingAsk() });
      if (p === "/ask" && req.method === "POST") {
        const { question, kind, options } = await readBody(req);
        if (!question) return json(res, 400, { error: "question required" });
        const id = `ask${++askSeq}`;
        // kind: input (default) | approve | choose | captcha — structured asks
        // let the console render one-tap widgets and let the master triage
        // safely (it never auto-answers approve/captcha).
        const k = ["input", "approve", "choose", "captcha"].includes(kind) ? kind : "input";
        const opts = Array.isArray(options) ? options.slice(0, 8).map(String) : undefined;
        asks.set(id, { question: String(question), kind: k, options: opts, answer: undefined, ts: Date.now() });
        return json(res, 200, { id });
      }
      if (p === "/ask/wait" && req.method === "GET") {
        const id = u.searchParams.get("id");
        const a = asks.get(id);
        if (!a) return json(res, 404, { error: "unknown id" });
        // ?timeout=<ms> lets a caller long-poll on a short cadence (bridge-mcp
        // interleaves this with session polling every ~2-3s). Default 25s.
        const waitMs = Math.min(Math.max(parseInt(u.searchParams.get("timeout"), 10) || 25000, 500), 25000);
        const deadline = Date.now() + waitMs;
        const tick = () => {
          const cur = asks.get(id);
          if (cur && cur.answer !== undefined) return json(res, 200, { answered: true, answer: cur.answer });
          if (Date.now() > deadline) return json(res, 200, { answered: false });
          setTimeout(tick, 500);
        };
        return tick();
      }
      if (p === "/ask/answer" && req.method === "POST") {
        const { id, answer } = await readBody(req);
        const a = asks.get(id);
        if (!a) return json(res, 404, { error: "unknown id" });
        a.answer = String(answer ?? "");
        return json(res, 200, { ok: true });
      }
      // Abandon a stale unanswered ask (the asker gave up watching) so it
      // stops shadowing newer asks in the pending view.
      if (p === "/ask/abandon" && req.method === "POST") {
        const { id } = await readBody(req);
        const a = asks.get(id);
        if (a && a.answer === undefined) asks.delete(id);
        return json(res, 200, { ok: true });
      }
      res.writeHead(404);
      res.end();
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
  })
  .listen(PORT, "0.0.0.0", () => console.log(`[agent-bridge] listening on :${PORT} (daemon=${IS_DAEMON})`));
