// claude-shim — speaks the opencode-serve subset tenant-api drives, backed by
// the real Claude Code CLI in headless mode. One turn = one
// `claude -p --resume <sid> --output-format stream-json` spawn; state lives on
// the data volume so sessions survive restarts (verified: the CLI does not
// rewrite its credential file, so the provider Secret mounts read-only).
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
//
// ocMsg shape (what tenant-api's mapAgentTrajectory expects):
//   {info:{role,time:{completed},error}, parts:[{type:"text"|"tool",text,tool,
//    state:{status,title,input,output}}]}
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.SHIM_PORT || 4096);
const STATE_DIR = process.env.CLAUDE_SHIM_STATE || "/data/shim";
const WORKDIR = process.env.CLAUDE_SHIM_WORKDIR || "/workspace";
const MCP_CONFIG = process.env.CLAUDE_MCP_CONFIG || "";
const ALLOWED_TOOLS = process.env.CLAUDE_ALLOWED_TOOLS || "";
const MODEL_DEFAULT = process.env.CLAUDE_MODEL || "";

fs.mkdirSync(STATE_DIR, { recursive: true });

// ── session state ──────────────────────────────────────────────────────────
// One JSON file per session: {id, title, updated, cliSession, running, aborted,
// turns:[{role, ts, parts:[…]}]}. Small and append-mostly; a session is a chat.
const sessPath = (id) => path.join(STATE_DIR, `${id}.json`);
const load = (id) => {
  try { return JSON.parse(fs.readFileSync(sessPath(id), "utf8")); } catch { return null; }
};
const save = (s) => {
  s.updated = Date.now() / 1000;
  fs.writeFileSync(sessPath(s.id), JSON.stringify(s));
};
const list = () =>
  fs.readdirSync(STATE_DIR).filter((f) => f.endsWith(".json"))
    .map((f) => load(f.slice(0, -5))).filter(Boolean);

// session id -> { child, s }: abort MUST mutate the same in-memory session
// object the running turn closed over, or the flag never reaches it (and the
// turn's final save would clobber a flag written to a reloaded copy).
const procs = new Map();

// ── the CLI turn ───────────────────────────────────────────────────────────
// Streams stream-json events, folding them into ocMsg turns as they arrive so
// GET /message reflects a run in flight (that's how the UI shows live steps).
function runTurn(s, prompt, model) {
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (s.cliSession) args.push("--resume", s.cliSession);
  const m = model || MODEL_DEFAULT;
  if (m) args.push("--model", m);
  if (MCP_CONFIG) args.push("--mcp-config", MCP_CONFIG);
  if (ALLOWED_TOOLS) args.push("--allowedTools", ALLOWED_TOOLS);
  // The agent runs unattended: no interactive approval is possible, and the
  // pod IS the sandbox (its own namespace, default-deny egress).
  args.push("--dangerously-skip-permissions");

  // IS_SANDBOX: the CLI refuses --dangerously-skip-permissions when running as
  // root, which every engine pod does. This is the documented container escape
  // hatch — and the claim is true here: the pod IS the sandbox (own namespace,
  // default-deny egress, no host mounts).
  const child = spawn("claude", args, {
    cwd: WORKDIR,
    env: { ...process.env, IS_SANDBOX: "1" },
  });
  procs.set(s.id, { child, s });
  s.running = true;
  s.aborted = false;
  const turn = { role: "assistant", ts: 0, parts: [] };
  s.turns.push({ role: "user", ts: Date.now() / 1000, parts: [{ type: "text", text: prompt }] });
  s.turns.push(turn);
  save(s);

  let buf = "";
  let errTail = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      handleEvent(s, turn, ev);
    }
  });
  child.stderr.on("data", (d) => {
    // Keep the tail so a failed turn can report WHY (an expired subscription
    // token, a rate-limit window, a bad model id) instead of just an exit code.
    errTail = (errTail + d.toString()).slice(-500);
    process.stderr.write(`[claude] ${d}`);
  });
  child.on("close", (code) => {
    procs.delete(s.id);
    s.running = false;
    turn.ts = Date.now() / 1000;
    if (s.aborted) {
      // Marked even when partial text arrived — the task layer distinguishes
      // cancelled from done, and the partial output is kept for context.
      turn.error = { name: "aborted", message: "cancelled by the user" };
    } else if (code !== 0 && !turn.parts.some((p) => p.type === "text")) {
      const why = errTail.trim().split("\n").filter(Boolean).pop() || `claude exited ${code}`;
      turn.error = { name: "engine_error", message: why };
    }
    save(s);
  });
}

function handleEvent(s, turn, ev) {
  switch (ev.type) {
    case "system":
      // init carries the CLI's session id — persist it so the NEXT turn resumes.
      if (ev.subtype === "init" && ev.session_id) {
        s.cliSession = ev.session_id;
        save(s);
      }
      return;
    case "assistant": {
      for (const c of ev.message?.content ?? []) {
        if (c.type === "text" && c.text?.trim()) {
          turn.parts.push({ type: "text", text: c.text });
        } else if (c.type === "tool_use") {
          turn.parts.push({
            type: "tool", tool: c.name,
            state: { status: "running", title: c.name, input: c.input ?? {}, output: null },
            _id: c.id,
          });
        }
      }
      save(s);
      return;
    }
    case "user": {
      // tool_result turns close out the matching tool part.
      for (const c of ev.message?.content ?? []) {
        if (c.type !== "tool_result") continue;
        const p = turn.parts.find((x) => x.type === "tool" && x._id === c.tool_use_id);
        if (!p) continue;
        p.state.status = c.is_error ? "error" : "completed";
        p.state.output = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
      }
      save(s);
      return;
    }
    case "rate_limit_event":
      // Subscription quota window — surfaced verbatim so the UI can say
      // "your Claude plan is cooling down" instead of failing cryptically.
      s.rateLimit = ev;
      save(s);
      return;
    case "result": {
      if (ev.subtype !== "success" && !turn.parts.some((p) => p.type === "text")) {
        turn.error = { name: ev.subtype || "error", message: ev.result || "run failed" };
      } else if (ev.result?.trim() && !turn.parts.some((p) => p.type === "text")) {
        turn.parts.push({ type: "text", text: ev.result });
      }
      if (!s.title || s.title === "New session") {
        s.title = String(turn.parts.find((p) => p.type === "text")?.text || s.title || "")
          .split("\n")[0].slice(0, 120) || s.title;
      }
      save(s);
      return;
    }
  }
}

// ── wire mapping ───────────────────────────────────────────────────────────
const toOcMsg = (t) => ({
  info: { role: t.role, time: { completed: t.ts || 0 }, error: t.error ?? null },
  role: t.role,
  parts: (t.parts ?? []).map(({ _id, ...p }) => p),
});

// Todos come from the CLI's TodoWrite tool: the newest todo tool call in the
// session IS the live plan.
function todosOf(s) {
  for (let i = s.turns.length - 1; i >= 0; i--) {
    for (const p of s.turns[i].parts ?? []) {
      if (p.type === "tool" && /todo/i.test(p.tool || "")) {
        const todos = p.state?.input?.todos;
        if (Array.isArray(todos)) {
          return todos.map((td) => ({
            content: td.content ?? td.activeForm ?? "",
            status: td.status ?? "pending",
          }));
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

  if (req.method === "GET" && url.pathname === "/health/ready") {
    return send(res, 200, {
      ok: true,
      busy: [...procs.keys()].length > 0,
      sessions: list().length,
      engine: "claude",
    });
  }

  // /session
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

  // /session/{id}[/…]
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
        live.s.aborted = true; // the object the turn's close handler reads
        live.child.kill("SIGTERM");
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

server.listen(PORT, () => console.log(`claude-shim listening on :${PORT} (state ${STATE_DIR})`));
