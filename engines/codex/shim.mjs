// codex-shim — speaks the opencode-serve subset tenant-api drives, backed by
// the real Codex CLI in exec mode. One turn = one
// `codex exec --json [resume <thread>] <prompt>` spawn; state lives on the
// data volume so sessions survive restarts. Structure mirrors claude-shim —
// same contract, same event bus, same abort semantics — only the CLI dialect
// differs.
//
// CLI facts this shim is built on (probed against codex-cli 0.147.0):
//   - `--json` emits JSONL: thread.started{thread_id} → turn.started →
//     item.* → turn.completed | turn.failed{error.message}.
//   - the process EXITS 0 even when the turn fails — the verdict lives in
//     the turn.failed event, never in the exit code.
//   - `codex exec resume <SESSION_ID> <PROMPT>` continues a thread.
//   - codex reads stdin ("Reading additional input from stdin...") — stdin
//     must be closed on spawn or a turn hangs forever.
//
// Contract (all JSON, no auth — the pod is reachable only in-namespace):
//   POST /session                  {title}   -> {id}
//   GET  /session                            -> [{id,title,time:{updated}}]
//   GET  /session/{id}                       -> {id,title}
//   POST /session/{id}/prompt_async {parts,model?} -> {} (fires, returns now)
//   GET  /session/{id}/message               -> [ocMsg] (trajectory source)
//   GET  /session/{id}/todo                  -> [{content,status}]
//   POST /session/{id}/abort                 -> {}
//   GET  /health/ready                       -> {ok,busy,sessions}
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.SHIM_PORT || 4096);
const STATE_DIR = process.env.CODEX_SHIM_STATE || "/data/shim";
const WORKDIR = process.env.CODEX_SHIM_WORKDIR || "/workspace";
const MODEL_DEFAULT = process.env.CODEX_MODEL || "";

fs.mkdirSync(STATE_DIR, { recursive: true });

// ── session state (identical to claude-shim) ───────────────────────────────
const sessPath = (id) => path.join(STATE_DIR, `${id}.json`);
const load = (id) => {
  try { return JSON.parse(fs.readFileSync(sessPath(id), "utf8")); } catch { return null; }
};
const save = (s) => {
  s.updated = Date.now() / 1000;
  fs.writeFileSync(sessPath(s.id), JSON.stringify(s));
  broadcast({ type: "session.updated", properties: { sessionID: s.id, running: !!s.running } });
};

// ── /event bus ─────────────────────────────────────────────────────────────
const eventClients = new Set();
function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of eventClients) {
    try { res.write(line); } catch { eventClients.delete(res); }
  }
}
setInterval(() => {
  for (const res of eventClients) {
    try { res.write(": ping\n\n"); } catch { eventClients.delete(res); }
  }
}, 25000).unref();
const list = () =>
  fs.readdirSync(STATE_DIR).filter((f) => f.endsWith(".json"))
    .map((f) => load(f.slice(0, -5))).filter(Boolean);

const procs = new Map();

// ── models ─────────────────────────────────────────────────────────────────
// With an API key the list is live from OpenAI's models API, filtered to what
// codex can drive. A ChatGPT subscription has no public models endpoint, so it
// gets the bootstrap list — kept deliberately short and current-generation;
// the CLI accepts any valid id typed into a task regardless.
const MODELS_CACHE = path.join(STATE_DIR, "models.json");
let modelsMem = { at: 0, list: null };
const BOOTSTRAP_MODELS = ["gpt-5.2-codex", "gpt-5.1-codex", "gpt-5.1-codex-mini"];
async function listModels() {
  if (modelsMem.list && Date.now() - modelsMem.at < 600_000) return modelsMem.list;
  if (process.env.OPENAI_API_KEY) {
    try {
      const r = await fetch("https://api.openai.com/v1/models", {
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      });
      if (r.ok) {
        const j = await r.json();
        const list = (j.data ?? [])
          .map((m) => m.id)
          .filter((id) => /codex|^gpt-5/.test(id) && !/audio|realtime|image|tts|transcribe/.test(id))
          .sort().reverse()
          .map((id) => ({ id, image: true }));
        if (list.length) {
          modelsMem = { at: Date.now(), list };
          try { fs.writeFileSync(MODELS_CACHE, JSON.stringify(list)); } catch {}
          return list;
        }
      }
    } catch {}
  }
  try {
    const list = JSON.parse(fs.readFileSync(MODELS_CACHE, "utf8"));
    if (Array.isArray(list) && list.length) return list;
  } catch {}
  return BOOTSTRAP_MODELS.map((id) => ({ id, image: true }));
}

// friendlyError — a subscription is a living credential; its failures must
// read as instructions, not transport dumps.
function friendlyError(text) {
  const t = String(text || "");
  if (/401|unauthorized|not logged in|login required|token (expired|revoked|invalid)|invalid api key|missing bearer/i.test(t)) {
    return {
      name: "auth_failed",
      message:
        "OpenAI rejected the credential — the ChatGPT login has likely expired or the API key is invalid. " +
        "Reconnect the provider on the Integrations page (for a subscription: run `codex login` on your machine " +
        "and paste the refreshed auth file).",
    };
  }
  if (/rate.?limit|usage limit|limit reached|too many requests|429|quota/i.test(t)) {
    return {
      name: "rate_limited",
      message:
        "Your ChatGPT plan hit its usage window. It resets automatically — try again in a bit, " +
        "or switch this agent to another provider meanwhile.",
    };
  }
  return null;
}

// ── the CLI turn ───────────────────────────────────────────────────────────
function runTurn(s, prompt, model) {
  const args = ["exec", "--json", "--skip-git-repo-check",
    // The agent runs unattended and the pod IS the sandbox (own namespace,
    // default-deny egress, no host mounts) — same argument as the claude
    // engine's IS_SANDBOX. Codex's own sandbox would fight the container.
    "--dangerously-bypass-approvals-and-sandbox"];
  const m = model || MODEL_DEFAULT;
  if (m) args.push("--model", m);
  if (s.cliSession) args.push("resume", s.cliSession, prompt);
  else args.push(prompt);

  const child = spawn("codex", args, { cwd: WORKDIR, env: { ...process.env } });
  // codex waits on stdin for "additional input" — close it or the turn hangs.
  child.stdin.end();
  procs.set(s.id, { child, s });
  s.running = true;
  s.aborted = false;
  const turn = { role: "assistant", ts: 0, parts: [] };
  s.turns.push({ role: "user", ts: Date.now() / 1000, parts: [{ type: "text", text: prompt }] });
  s.turns.push(turn);
  save(s);

  let buf = "";
  let lastError = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || !line.startsWith("{")) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      lastError = handleEvent(s, turn, ev) || lastError;
    }
  });
  child.stderr.on("data", (d) => process.stderr.write(`[codex] ${d}`));
  child.on("close", () => {
    procs.delete(s.id);
    s.running = false;
    turn.ts = Date.now() / 1000;
    if (s.aborted) {
      turn.error = { name: "aborted", message: "cancelled by the user" };
    } else if (turn.failed && !turn.parts.some((p) => p.type === "text")) {
      // codex exits 0 even on failure — turn.failed (recorded by handleEvent)
      // is the real verdict, lastError the most legible reason.
      turn.error = friendlyError(lastError) ?? { name: "engine_error", message: lastError || "run failed" };
    }
    delete turn.failed;
    save(s);
  });
}

// handleEvent folds codex --json events into the ocMsg turn. Returns an error
// string when the event carries one (the caller keeps the latest).
function handleEvent(s, turn, ev) {
  switch (ev.type) {
    case "thread.started":
      if (ev.thread_id) { s.cliSession = ev.thread_id; save(s); }
      return;
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const it = ev.item || {};
      const kind = it.item_type || it.type || "";
      const done = ev.type === "item.completed";
      if (kind === "agent_message") {
        if (done && it.text?.trim()) turn.parts.push({ type: "text", text: it.text });
        save(s);
        return;
      }
      if (kind === "reasoning") return; // thinking stays internal, like claude's
      // Everything else is a tool part keyed by the item id, updated in place
      // across started → completed so the UI shows live steps.
      let p = turn.parts.find((x) => x.type === "tool" && x._id === it.id);
      if (!p) {
        p = { type: "tool", tool: "", state: { status: "running", title: "", input: {}, output: null }, _id: it.id };
        turn.parts.push(p);
      }
      if (kind === "command_execution") {
        p.tool = "bash";
        p.state.title = String(it.command || "").slice(0, 120);
        p.state.input = { command: it.command || "" };
        if (done) {
          p.state.status = it.exit_code === 0 || it.status === "completed" ? "completed" : "error";
          p.state.output = String(it.aggregated_output ?? "").slice(-4000);
        }
      } else if (kind === "mcp_tool_call") {
        p.tool = [it.server, it.tool].filter(Boolean).join("_") || "mcp";
        p.state.title = p.tool;
        p.state.input = it.arguments ?? {};
        if (done) {
          p.state.status = it.status === "failed" ? "error" : "completed";
          p.state.output = typeof it.result === "string" ? it.result : JSON.stringify(it.result ?? "");
        }
      } else if (kind === "todo_list") {
        p.tool = "todowrite";
        p.state.title = "update plan";
        p.state.input = {
          todos: (it.items ?? []).map((td) => ({
            content: td.text ?? "",
            status: td.completed ? "completed" : "pending",
          })),
        };
        if (done) p.state.status = "completed";
      } else if (kind === "file_change") {
        p.tool = "edit";
        p.state.title = (it.changes ?? []).map((c) => c.path).filter(Boolean).join(", ").slice(0, 120) || "file change";
        if (done) p.state.status = it.status === "failed" ? "error" : "completed";
      } else if (kind === "web_search") {
        p.tool = "websearch";
        p.state.title = it.query || "web search";
        if (done) p.state.status = "completed";
      } else {
        p.tool = kind || "step";
        p.state.title = kind;
        if (done) p.state.status = "completed";
      }
      save(s);
      return;
    }
    case "error":
      return String(ev.message || "");
    case "turn.failed": {
      turn.failed = true;
      const msg = String(ev.error?.message || "");
      save(s);
      return msg;
    }
    case "turn.completed": {
      if (!s.title || s.title === "New session") {
        s.title = String(turn.parts.find((p) => p.type === "text")?.text || s.title || "")
          .split("\n")[0].slice(0, 120) || s.title;
      }
      save(s);
      return;
    }
  }
}

// ── wire mapping (identical to claude-shim) ────────────────────────────────
const toOcMsg = (t) => ({
  info: { role: t.role, time: { completed: t.ts || 0 }, error: t.error ?? null },
  role: t.role,
  parts: (t.parts ?? []).map(({ _id, ...p }) => p),
});

function todosOf(s) {
  for (let i = s.turns.length - 1; i >= 0; i--) {
    for (const p of s.turns[i].parts ?? []) {
      if (p.type === "tool" && /todo/i.test(p.tool || "")) {
        const todos = p.state?.input?.todos;
        if (Array.isArray(todos)) {
          return todos.map((td) => ({ content: td.content ?? "", status: td.status ?? "pending" }));
        }
      }
    }
  }
  return [];
}

// ── HTTP ───────────────────────────────────────────────────────────────────
const send = (res, code, obj) => {
  const b = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
  res.end(b);
};
const readBody = (req) => new Promise((resolve) => {
  let b = "";
  req.on("data", (d) => { b += d; if (b.length > 8e6) req.destroy(); });
  req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const seg = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/config/providers") {
    const providerID = process.env.CODEX_PROVIDER_ID || "chatgpt-subscription";
    const models = await listModels();
    return send(res, 200, {
      providers: [{
        id: providerID,
        models: Object.fromEntries(models.map((m) => [m.id, { capabilities: { input: { image: m.image } } }])),
      }],
      default: { [providerID]: models[0]?.id ?? "" },
    });
  }

  if (req.method === "GET" && url.pathname === "/event") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
    eventClients.add(res);
    req.on("close", () => eventClients.delete(res));
    return;
  }

  if (req.method === "GET" && url.pathname === "/health/ready") {
    return send(res, 200, {
      ok: true,
      busy: [...procs.keys()].length > 0,
      sessions: list().length,
      engine: "codex",
    });
  }

  if (seg[0] === "session" && seg.length === 1) {
    if (req.method === "POST") {
      const body = await readBody(req);
      const s = {
        id: randomUUID(), title: body.title || "New session",
        cliSession: "", running: false, turns: [],
      };
      save(s);
      return send(res, 200, { id: s.id, title: s.title });
    }
    if (req.method === "GET") {
      return send(res, 200, list()
        .sort((a, b) => (b.updated || 0) - (a.updated || 0))
        .map((s) => ({ id: s.id, title: s.title, time: { updated: s.updated || 0 } })));
    }
  }

  if (seg[0] === "session" && seg.length >= 2) {
    const s = load(seg[1]);
    if (!s) return send(res, 404, { error: "session not found" });
    const tail = seg[2];

    if (!tail && req.method === "GET") return send(res, 200, { id: s.id, title: s.title });
    if (tail === "message" && req.method === "GET") {
      return send(res, 200, (s.turns ?? []).map(toOcMsg));
    }
    if (tail === "todo" && req.method === "GET") return send(res, 200, todosOf(s));
    if (tail === "abort" && req.method === "POST") {
      const live = procs.get(s.id);
      if (live) {
        live.s.aborted = true;
        live.child.kill("SIGTERM");
        setTimeout(() => {
          if (procs.get(s.id)?.child === live.child) {
            try { live.child.kill("SIGKILL"); } catch {}
          }
        }, 2000).unref();
      } else {
        s.aborted = true;
        save(s);
      }
      return send(res, 200, {});
    }
    if ((tail === "prompt_async" || tail === "prompt") && req.method === "POST") {
      const body = await readBody(req);
      const prompt = (body.parts ?? [])
        .filter((p) => p.type === "text").map((p) => p.text).join("\n").trim();
      if (!prompt) return send(res, 400, { error: "empty prompt" });
      if (procs.has(s.id)) return send(res, 409, { error: "session is busy" });
      runTurn(s, prompt, body.model?.modelID || "");
      return send(res, 200, {});
    }
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`codex-shim listening on :${PORT} (state ${STATE_DIR})`));
