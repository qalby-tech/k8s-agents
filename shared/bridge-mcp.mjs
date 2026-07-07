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
const TENANT = (() => {
  if (process.env.TENANT_NAME) return process.env.TENANT_NAME;
  try {
    const ns = readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/namespace", "utf8").trim();
    if (ns.startsWith("tenant-")) return ns.slice("tenant-".length);
  } catch {}
  return "";
})();
const PROTOCOL_VERSION = "2024-11-05";
const ASK_TIMEOUT_MS = 15 * 60 * 1000;
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

async function askHuman({ question, kind, options }) {
  if (!question || !String(question).trim()) throw new Error("ask_human requires a non-empty question");
  const created = await jfetch(`${BRIDGE}/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: String(question), kind, options }),
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
  const r = await jfetch(u, {}, 15000);
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
      "Ask the human user a question and wait for their reply. Use for decisions, " +
      "missing info, credentials, or confirmation before something risky. Blocks " +
      "until they answer (~15 min). Returns their exact words.",
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
