// db-admin — deterministic database administration behind the agent-bridge's
// /db/* endpoints (status-server.mjs mounts these on :4097). No LLM in the
// loop: every operation shells out to psql / redis-cli using the connection
// env the storage-daemon pod already carries (postgres: PGHOST/PGPORT/
// PGDATABASE/PGUSER/PGPASSWORD; redis: REDIS_HOST/REDIS_PORT + optional
// REDIS_PASSWORD).
//
// Safety rules, in one place:
//   - passwords never appear in responses, logs or thrown errors — psql gets
//     them via env (PGPASSWORD) or a dollar-quoted literal that is redacted
//     from any stderr we surface; redis-cli auth goes via REDISCLI_AUTH;
//   - every identifier that reaches SQL is gated by IDENT_RE (400 otherwise)
//     — nothing user-supplied is ever string-interpolated unquoted;
//   - every psql call runs with -v ON_ERROR_STOP=1 and a statement_timeout;
//   - migration SQL is capped at 256 KB and applied in ONE transaction with
//     the _platform_migrations bookkeeping row, so a failure rolls back both.
//
// Handlers return { status, body } so the bridge's router stays a thin map.
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, rm, mkdtemp } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GITEA = "http://gitea-http.gitea.svc.cluster.local:3000";
const REPO_DIR = "/workspace/.db-migrations-repo";
const MAX_SQL = 256 * 1024;
const STMT_TIMEOUT = "SET statement_timeout='10s';";

export const engine = () =>
  process.env.PGHOST ? "postgres" : process.env.REDIS_HOST ? "redis" : null;

// ── pure helpers (no I/O — unit-testable with node -e) ───────────────────────

// Strict identifier gate for role/database names that reach SQL / ACL SETUSER.
export const IDENT_RE = /^[a-z_][a-z0-9_]{0,30}$/;
export const validIdent = (s) => typeof s === "string" && IDENT_RE.test(s);
const qIdent = (s) => `"${s}"`; // callers MUST gate with validIdent first

// Dollar-quote an arbitrary literal under a random tag. The value can never
// terminate the quote: a tag the value happens to contain is rejected and
// re-rolled, so no password content can escape into SQL.
export function dollarQuote(value) {
  for (let i = 0; i < 8; i++) {
    const tag = `$dq${randomBytes(6).toString("hex")}$`;
    if (!String(value).includes(tag)) return `${tag}${value}${tag}`;
  }
  throw new Error("could not pick a safe quoting tag");
}

export const slugify = (name) =>
  String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "migration";

// SQL for POST /db/users. Identifiers are pre-gated; the password is
// dollar-quoted. Returns the redact list so the caller can scrub any psql
// stderr that might echo the statement.
export function pgCreateUserSQL(username, password, grants, database) {
  const u = qIdent(username), d = qIdent(database), pw = dollarQuote(password);
  const stmts = [
    `CREATE ROLE ${u} LOGIN PASSWORD ${pw}`,
    `GRANT CONNECT ON DATABASE ${d} TO ${u}`,
    `GRANT USAGE ON SCHEMA public TO ${u}`,
  ];
  if (grants === "read") {
    stmts.push(
      `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${u}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${u}`,
    );
  } else if (grants === "readwrite") {
    stmts.push(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${u}`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${u}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${u}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${u}`,
    );
  } else { // admin
    stmts.push(
      `GRANT ALL PRIVILEGES ON DATABASE ${d} TO ${u}`,
      `GRANT ALL ON SCHEMA public TO ${u}`,
      `GRANT ALL ON ALL TABLES IN SCHEMA public TO ${u}`,
      `GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${u}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${u}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${u}`,
    );
  }
  return { sql: STMT_TIMEOUT + stmts.join(";\n") + ";", redact: [pw] };
}

// argv for redis ACL SETUSER (no shell — execFile array, so `>pw` is inert).
// +@connection is added on top of the category grants so the new user can
// actually AUTH/PING/SELECT its way in.
export function redisSetUserArgs(username, password, grants) {
  const perms =
    grants === "admin" ? ["allkeys", "allchannels", "+@all"]
    : grants === "readwrite" ? ["allkeys", "+@read", "+@write", "+@connection"]
    : ["allkeys", "+@read", "+@connection"];
  return ["ACL", "SETUSER", username, "reset", "on", `>${password}`, ...perms];
}

// redis INFO → flat {key: value}; keyspace lines ("db0:keys=1,expires=0,…")
// → {db0: {keys, expires}}.
export const parseInfo = (text) => {
  const m = {};
  for (const line of String(text).split("\n")) {
    const i = line.indexOf(":");
    if (i > 0 && !line.startsWith("#")) m[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return m;
};
export const parseKeyspace = (info) => {
  const dbs = {};
  for (const [k, v] of Object.entries(info))
    if (/^db\d+$/.test(k)) {
      const kv = Object.fromEntries(v.split(",").map((p) => p.split("=")));
      dbs[k] = { keys: Number(kv.keys || 0), expires: Number(kv.expires || 0) };
    }
  return dbs;
};

// `ACL LIST` lines: "user <name> on|off <rules…>".
export const parseAclList = (text) =>
  String(text).split("\n").map((l) => l.trim()).filter((l) => l.startsWith("user "))
    .map((l) => { const t = l.split(/\s+/); return { name: t[1], enabled: t[2] === "on" }; });

// ── shelling out (secrets via env, stderr redacted + tail-capped) ────────────
function run(cmd, args, { env = {}, timeoutMs = 20000, redact = [] } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout));
        let msg = String(stderr || err.message || "").trim().slice(-800);
        for (const r of redact) if (r) msg = msg.split(r).join("[redacted]");
        reject(new Error(msg || "command failed"));
      });
  });
}

const psqlArgs = ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"];
const psqlCmd = (sql, { database, timeoutMs = 20000, redact } = {}) =>
  run("psql", [...psqlArgs, ...(database ? ["-d", database] : []), "-c", sql],
    { env: { PGCONNECT_TIMEOUT: "5" }, timeoutMs, redact });
const psqlFile = (path, { timeoutMs = 90000, redact } = {}) =>
  run("psql", [...psqlArgs, "-f", path], { env: { PGCONNECT_TIMEOUT: "5" }, timeoutMs, redact });

const redisCli = (args, { timeoutMs = 10000, redact } = {}) =>
  run("redis-cli", ["-h", process.env.REDIS_HOST, "-p", process.env.REDIS_PORT || "6379", ...args],
    { env: process.env.REDIS_PASSWORD ? { REDISCLI_AUTH: process.env.REDIS_PASSWORD } : {}, timeoutMs, redact });

const primaryUser = () => (engine() === "postgres" ? process.env.PGUSER || "app" : "default");
const bad = (status, error) => ({ status, body: { error } });

// ── GET /db/overview ─────────────────────────────────────────────────────────
export async function overview() {
  if (engine() === "postgres") {
    const out = await psqlCmd(STMT_TIMEOUT + `SELECT json_build_object(
      'version', current_setting('server_version'),
      'databases', (SELECT coalesce(json_agg(json_build_object('name', datname, 'sizeBytes', pg_database_size(datname)) ORDER BY datname), '[]'::json)
                      FROM pg_database WHERE NOT datistemplate),
      'connections', (SELECT count(*) FROM pg_stat_activity),
      'uptimeSeconds', floor(extract(epoch FROM now() - pg_postmaster_start_time()))::bigint);`);
    return { status: 200, body: { engine: "postgres", ...JSON.parse(out) } };
  }
  const info = parseInfo(await redisCli(["INFO"]));
  const dbs = parseKeyspace(info);
  return { status: 200, body: {
    engine: "redis",
    version: info.redis_version || "",
    usedMemory: Number(info.used_memory || 0),
    connections: Number(info.connected_clients || 0),
    uptimeSeconds: Number(info.uptime_in_seconds || 0),
    dbs,
    databases: Object.entries(dbs).map(([name, d]) => ({ name, keys: d.keys })),
  } };
}

// ── GET /db/schema?database= ─────────────────────────────────────────────────
export async function schema(database) {
  if (engine() !== "postgres") return bad(400, "schema is a postgres-only endpoint");
  if (database && !validIdent(database)) return bad(400, "invalid database name");
  // One SQL, one JSON document out — no ad-hoc separator parsing.
  const out = await psqlCmd(STMT_TIMEOUT + `SELECT coalesce(json_agg(t), '[]'::json) FROM (
    SELECT c.relnamespace::regnamespace::text AS schema, c.relname AS name,
           greatest(c.reltuples, 0)::bigint AS "rowEstimate",
           (SELECT coalesce(json_agg(json_build_object(
                     'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
                     'nullable', NOT a.attnotnull, 'default', pg_get_expr(ad.adbin, ad.adrelid)) ORDER BY a.attnum), '[]'::json)
              FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
             WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
           (SELECT coalesce(json_agg(json_build_object(
                     'name', i.indexrelid::regclass::text, 'definition', pg_get_indexdef(i.indexrelid)) ORDER BY 1), '[]'::json)
              FROM pg_index i WHERE i.indrelid = c.oid) AS indexes
      FROM pg_class c
     WHERE c.relkind IN ('r','p')
       AND c.relnamespace::regnamespace::text NOT IN ('pg_catalog','information_schema')
     ORDER BY 1, 2) t;`, { database });
  return { status: 200, body: { engine: "postgres", database: database || process.env.PGDATABASE || "", tables: JSON.parse(out) } };
}

// ── GET /db/users ────────────────────────────────────────────────────────────
export async function listUsers() {
  if (engine() === "postgres") {
    const out = await psqlCmd(STMT_TIMEOUT + `SELECT coalesce(json_agg(json_build_object(
        'name', r.rolname, 'super', r.rolsuper, 'canLogin', r.rolcanlogin,
        'memberships', (SELECT coalesce(json_agg(b.rolname ORDER BY b.rolname), '[]'::json)
                          FROM pg_auth_members m JOIN pg_roles b ON m.roleid = b.oid WHERE m.member = r.oid)
      ) ORDER BY r.rolname), '[]'::json) FROM pg_roles r WHERE r.rolname NOT LIKE 'pg\\_%';`);
    return { status: 200, body: { engine: "postgres", users: JSON.parse(out) } };
  }
  return { status: 200, body: { engine: "redis", users: parseAclList(await redisCli(["ACL", "LIST"])) } };
}

// ── POST /db/users {username, password, grants} ─────────────────────────────
export async function createUser(body) {
  const { username, password } = body || {};
  const grants = body?.grants || "read";
  if (!validIdent(username)) return bad(400, "invalid username: must match ^[a-z_][a-z0-9_]{0,30}$");
  if (typeof password !== "string" || password.length < 1 || password.length > 512)
    return bad(400, "password required (1-512 chars)");
  if (!["read", "readwrite", "admin"].includes(grants))
    return bad(400, "grants must be read | readwrite | admin");
  if (username === primaryUser()) return bad(400, "refusing to overwrite the primary database user");

  if (engine() === "postgres") {
    const db = process.env.PGDATABASE || "app";
    if (!validIdent(db)) return bad(500, "PGDATABASE is not a safe identifier");
    const { sql, redact } = pgCreateUserSQL(username, password, grants, db);
    try {
      await psqlCmd(sql, { redact });
    } catch (e) {
      return bad(400, `create user failed: ${e.message}`);
    }
    return { status: 200, body: { ok: true, engine: "postgres", username, grants } };
  }
  try {
    await redisCli(redisSetUserArgs(username, password, grants), { redact: [password] });
  } catch (e) {
    return bad(400, `ACL SETUSER failed: ${e.message}`);
  }
  await redisCli(["ACL", "SAVE"]).catch(() => {}); // no aclfile configured → fine
  return { status: 200, body: { ok: true, engine: "redis", username, grants } };
}

// ── DELETE /db/users/{name} ──────────────────────────────────────────────────
export async function deleteUser(name) {
  if (!validIdent(name)) return bad(400, "invalid username");
  if (name === primaryUser() || name === "postgres")
    return bad(400, "refusing to drop the primary database user");
  if (engine() === "postgres") {
    try {
      await psqlCmd(STMT_TIMEOUT + `DROP ROLE "${name}";`);
    } catch (e) {
      return bad(400, `drop role failed: ${e.message}`); // e.g. owns objects — surfaced verbatim
    }
    return { status: 200, body: { ok: true, dropped: name } };
  }
  try {
    const out = await redisCli(["ACL", "DELUSER", name]);
    if (out.trim() === "0") return bad(400, `no such user: ${name}`);
  } catch (e) {
    return bad(400, `ACL DELUSER failed: ${e.message}`);
  }
  await redisCli(["ACL", "SAVE"]).catch(() => {});
  return { status: 200, body: { ok: true, dropped: name } };
}

// ── migrations (postgres only) ───────────────────────────────────────────────
const ENSURE_MIGRATIONS = `CREATE TABLE IF NOT EXISTS _platform_migrations(
  version bigint PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());`;

export async function listMigrations() {
  if (engine() !== "postgres") return bad(400, "migrations are a postgres-only endpoint");
  await psqlCmd(STMT_TIMEOUT + ENSURE_MIGRATIONS);
  const out = await psqlCmd(STMT_TIMEOUT + `SELECT coalesce(json_agg(json_build_object(
      'version', version, 'name', name, 'appliedAt', applied_at) ORDER BY version DESC), '[]'::json)
    FROM _platform_migrations;`);
  return { status: 200, body: { engine: "postgres", migrations: JSON.parse(out) } };
}

// POST /db/migrations {name, sql} — apply in ONE transaction together with the
// bookkeeping INSERT (ON_ERROR_STOP aborts the file; the open transaction rolls
// back on disconnect, so a failed migration leaves no trace). Then best-effort
// commit the file to the workspace's Gitea — a git failure NEVER fails the
// migration (it's already committed to the DB); both statuses are reported.
export async function applyMigration(body) {
  if (engine() !== "postgres") return bad(400, "migrations are a postgres-only endpoint");
  const name = String(body?.name || "").trim();
  const sql = body?.sql;
  if (!name || name.length > 200) return bad(400, "name required (<= 200 chars)");
  if (typeof sql !== "string" || !sql.trim()) return bad(400, "sql required");
  if (Buffer.byteLength(sql) > MAX_SQL) return bad(400, "sql too large (256KB cap)");

  await psqlCmd(STMT_TIMEOUT + ENSURE_MIGRATIONS);
  const version = Date.now();
  const script =
    `BEGIN;\nSET LOCAL statement_timeout='60s';\n${sql}\n;\n` +
    `INSERT INTO _platform_migrations(version, name) VALUES (${version}, ${dollarQuote(name)});\nCOMMIT;\n`;
  const dir = await mkdtemp(join(tmpdir(), "db-mig-"));
  const file = join(dir, "migration.sql");
  try {
    await writeFile(file, script);
    await psqlFile(file);
  } catch (e) {
    return { status: 422, body: { error: "migration failed (rolled back)", detail: e.message } };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  const git = await commitMigrationToGit(version, name, sql).catch((e) => `failed: ${e.message}`);
  return { status: 200, body: { ok: true, version, name, git } };
}

// ── git best-effort (never blocks the applied migration) ─────────────────────
const readEtc = (f) => readFile(`/etc/aidaemon/${f}`, "utf8").then((s) => s.trim()).catch(() => "");

async function git(args, { redact, cwd } = {}) {
  return run("git", cwd ? ["-C", cwd, ...args] : args, { timeoutMs: 30000, redact });
}

async function commitMigrationToGit(version, name, sql) {
  // Org/repo discovery: platform-wired env first, then an optional Secret key.
  // Not discoverable yet → skip (the platform side wires AGENT_GIT_ORG /
  // AGENT_WORKLOAD_ID later); the migration itself is already applied.
  const org = process.env.AGENT_GIT_ORG || (await readEtc("gitea_org"));
  if (!org) return "skipped: org unknown";
  const repo = process.env.AGENT_DB_REPO || (await readEtc("db_repo")) ||
    (process.env.AGENT_WORKLOAD_ID ? `db-${process.env.AGENT_WORKLOAD_ID}` : "");
  if (!repo) return "skipped: repo unknown (no AGENT_WORKLOAD_ID)";
  const user = await readEtc("git_user");
  const token = await readEtc("git_token");
  if (!user || !token) return "skipped: no git credentials";

  const url = `${GITEA}/${encodeURIComponent(org)}/${encodeURIComponent(repo)}.git`;
  const authed = url.replace("://", `://${encodeURIComponent(user)}:${encodeURIComponent(token)}@`);
  const redact = [token, encodeURIComponent(token)];

  // Clone-or-pull into a fixed workdir; auto-create the repo on first use.
  const cloned = await readFile(join(REPO_DIR, ".git", "HEAD"), "utf8").then(() => true).catch(() => false);
  if (!cloned) {
    await rm(REPO_DIR, { recursive: true, force: true }).catch(() => {});
    try {
      await git(["clone", authed, REPO_DIR], { redact });
    } catch {
      const r = await fetch(`${GITEA}/api/v1/orgs/${encodeURIComponent(org)}/repos`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Basic " + Buffer.from(`${user}:${token}`).toString("base64"),
        },
        body: JSON.stringify({ name: repo, private: true, auto_init: true, description: "platform-managed DB migrations" }),
      }).catch(() => null);
      if (!r || (!r.ok && r.status !== 409)) return `failed: could not clone or create ${org}/${repo}`;
      await git(["clone", authed, REPO_DIR], { redact });
    }
  } else {
    await git(["remote", "set-url", "origin", authed], { cwd: REPO_DIR, redact });
    await git(["pull", "--ff-only"], { cwd: REPO_DIR, redact }).catch(() => {}); // diverged → push still attempted
  }

  const rel = `migrations/${version}_${slugify(name)}.sql`;
  await mkdir(join(REPO_DIR, "migrations"), { recursive: true });
  await writeFile(join(REPO_DIR, rel), sql.endsWith("\n") ? sql : sql + "\n");
  await git(["add", rel], { cwd: REPO_DIR, redact });
  await git(["-c", "user.name=AI DB Agent", "-c", "user.email=ai@git.live-llm.com",
    "commit", "-m", `migration ${version}: ${name}`], { cwd: REPO_DIR, redact });
  await git(["push", "origin", "HEAD"], { cwd: REPO_DIR, redact });
  return `committed ${rel} to ${org}/${repo}`;
}
