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
//
// Attachments are per-session dirs (outbox/<session>, inbox/<session>); another
// session can still read them by path on disk.
import http from "node:http";
import { execFile } from "node:child_process";
import { readFile, readdir, stat, mkdir, unlink, writeFile, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, basename, extname } from "node:path";

const PORT = 4097;
const OUTBOX = process.env.AGENT_OUTBOX || "/workspace/outbox";
const INBOX = process.env.AGENT_INBOX || "/workspace/inbox";
const IS_DAEMON = await readFile("/etc/aidaemon/vm_user", "utf8").then(() => true).catch(() => false);
const GUI = await readFile("/etc/aidaemon/vm_gui", "utf8").then((s) => s.trim() === "true").catch(() => false);

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
    const mres = await fetch(`http://127.0.0.1:4096/session/${sid}/message`);
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
async function busy() {
  if (busyCache && Date.now() - busyAt < 2500) return busyCache;
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

// ── ask-human (global; transient) ────────────────────────────────────────────
const asks = new Map();
let askSeq = 0;
const pendingAsk = () => {
  for (const [id, a] of asks) if (a.answer === undefined) return { id, question: a.question, ts: a.ts };
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

      if (p === "/ask" && req.method === "GET") return json(res, 200, { pending: pendingAsk() });
      if (p === "/ask" && req.method === "POST") {
        const { question } = await readBody(req);
        if (!question) return json(res, 400, { error: "question required" });
        const id = `ask${++askSeq}`;
        asks.set(id, { question: String(question), answer: undefined, ts: Date.now() });
        return json(res, 200, { id });
      }
      if (p === "/ask/wait" && req.method === "GET") {
        const id = u.searchParams.get("id");
        const a = asks.get(id);
        if (!a) return json(res, 404, { error: "unknown id" });
        const deadline = Date.now() + 25000;
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
      res.writeHead(404);
      res.end();
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
  })
  .listen(PORT, "0.0.0.0", () => console.log(`[agent-bridge] listening on :${PORT} (daemon=${IS_DAEMON})`));
