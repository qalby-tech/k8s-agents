// agent-bridge — the AI daemon/master's local HTTP server on :4097. Three jobs:
//
//   GET  /status            guest status (daemon only): SSH key-auth / cloud-init
//                           / cua. The master returns a minimal {online:true}.
//   GET  /outbox            files the agent shared with the user (in /workspace
//   GET  /outbox/<name>     /outbox) — agent → chat attachments.
//   GET  /ask               the pending human question (or null)
//   POST /ask               { question } -> { id } (called by the ask_human MCP tool)
//   GET  /ask/wait?id=      long-poll: { answered, answer } (the MCP tool blocks here)
//   POST /ask/answer        { id, answer } (the chat UI answers)
//
// tenant-api proxies this; the chat polls it. Everything reuses the daemon's own
// ~/.ssh (Host vm) for the SSH probes — the same hop the agent uses.
import http from "node:http";
import { execFile } from "node:child_process";
import { readFile, readdir, stat, mkdir, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, basename, extname } from "node:path";

const PORT = 4097;
const OUTBOX = process.env.AGENT_OUTBOX || "/workspace/outbox";
// Files the USER attaches in the chat, materialized so the agent can open them
// (a PDF the model can't read is still readable here with tools).
const INBOX = process.env.AGENT_INBOX || "/workspace/inbox";
// Master mode has no VM (no /etc/aidaemon/vm_user); skip the SSH probes there.
const IS_DAEMON = await readFile("/etc/aidaemon/vm_user", "utf8").then(() => true).catch(() => false);
const GUI = await readFile("/etc/aidaemon/vm_gui", "utf8").then((s) => s.trim() === "true").catch(() => false);

await mkdir(OUTBOX, { recursive: true }).catch(() => {});
await mkdir(INBOX, { recursive: true }).catch(() => {});

function sh(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => resolve({ ok: !err, out: (stdout || "").trim() }));
  });
}
const ssh = (remote) => sh("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "vm", remote]);

async function probe() {
  if (!IS_DAEMON) return { online: true, master: true, ts: Date.now() };
  const sshOk = (await ssh("true")).ok;
  let cloudInit = "unknown",
    cuaInstalled = false,
    cuaActive = false;
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
    .then((s) => s.trim().split("\n").slice(-3).join("\n"))
    .catch(() => "");
  return { gui: GUI, sshOk, cloudInit, cuaInstalled, cuaActive, bootstrapStatus, bootstrapTail, ts: Date.now() };
}

// Cache + single-flight so polling doesn't spawn an SSH storm.
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

async function listOutbox() {
  const names = await readdir(OUTBOX).catch(() => []);
  const captions = await readFile(join(OUTBOX, ".captions.json"), "utf8").then((s) => JSON.parse(s)).catch(() => ({}));
  const out = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const st = await stat(join(OUTBOX, name)).catch(() => null);
    if (!st || !st.isFile()) continue;
    out.push({ name, size: st.size, mime: mimeOf(name), mtime: st.mtimeMs, caption: captions[name] || "" });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// ── ask-human state (single pending question at a time is enough) ────────────
const asks = new Map(); // id -> { question, answer, ts }
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

      if (p === "/outbox" && req.method === "GET") return json(res, 200, { files: await listOutbox() });
      if (p.startsWith("/outbox/") && req.method === "GET") {
        const name = basename(decodeURIComponent(p.slice("/outbox/".length)));
        const full = join(OUTBOX, name);
        const st = await stat(full).catch(() => null);
        if (!st || !st.isFile()) return json(res, 404, { error: "not found" });
        res.writeHead(200, { "content-type": mimeOf(name), "content-length": st.size, "cache-control": "no-store" });
        return createReadStream(full).pipe(res);
      }
      // The chat's "remove" button — let the user clear a shared file.
      if (p.startsWith("/outbox/") && req.method === "DELETE") {
        const name = basename(decodeURIComponent(p.slice("/outbox/".length)));
        await unlink(join(OUTBOX, name)).catch(() => {});
        const cf = join(OUTBOX, ".captions.json");
        const map = await readFile(cf, "utf8").then((s) => JSON.parse(s)).catch(() => ({}));
        if (map[name]) { delete map[name]; await writeFile(cf, JSON.stringify(map)).catch(() => {}); }
        return json(res, 200, { ok: true });
      }
      // User attachments: materialized on the agent's machine so it can open them.
      if (p === "/inbox" && req.method === "POST") {
        const { name, data } = await readBody(req);
        if (!name || !data) return json(res, 400, { error: "name and data required" });
        const safe = basename(String(name));
        const b64 = String(data).replace(/^data:[^;]*;base64,/, "");
        await writeFile(join(INBOX, safe), Buffer.from(b64, "base64"));
        return json(res, 200, { ok: true, path: join(INBOX, safe) });
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
        // short long-poll: resolve as soon as answered, else time out so the
        // client re-polls (keeps the MCP tool responsive without a hung socket).
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
