// status-server — a tiny health endpoint for the AI daemon, on :4097.
//
// opencode (:4096) has no place to report *guest* state, so this server runs the
// same SSH probes the daemon already uses and answers them as JSON. tenant-api
// proxies it; the AI Daemon tab polls it to show "password ✓ / installing GUI… /
// working" instead of the user guessing.
//
// Everything here reuses the daemon's own ~/.ssh (Host vm, ControlMaster) laid
// out by the init container, so `ssh vm …` is the same hop the agent uses.
import http from "node:http";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

const PORT = 4097;
const GUI = await readFile("/etc/aidaemon/vm_gui", "utf8")
  .then((s) => s.trim() === "true")
  .catch(() => false);

function sh(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      resolve({ ok: !err, out: (stdout || "").trim() });
    });
  });
}
const ssh = (remote) =>
  sh("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "vm", remote]);

async function probe() {
  // key auth working == the one-time ssh-copy-id bootstrap succeeded, which means
  // the VM password the user gave was correct and the VM is reachable.
  const sshOk = (await ssh("true")).ok;
  let cloudInit = "unknown";
  let cuaInstalled = false;
  let cuaActive = false;
  if (sshOk) {
    cloudInit =
      (await ssh("cloud-init status 2>/dev/null | sed -n 's/^status: //p'")).out || "done";
    if (GUI) {
      cuaInstalled =
        (await ssh("command -v cua-computer-server >/dev/null 2>&1 || ls ~/.local/bin/cua-computer-server >/dev/null 2>&1; echo $?"))
          .out === "0";
      cuaActive =
        (await ssh("systemctl is-active cua-computer-server 2>/dev/null")).out === "active";
    }
  }
  // running | unreachable | auth-failed | ok — written by agent-bootstrap. The
  // UI colours the badge red on "auth-failed" (wrong VM password).
  const bootstrapStatus = await readFile("/tmp/agent-bootstrap.status", "utf8")
    .then((s) => s.trim())
    .catch(() => "");
  const bootstrapTail = await readFile("/tmp/agent-bootstrap.log", "utf8")
    .then((s) => s.trim().split("\n").slice(-3).join("\n"))
    .catch(() => "");
  return { gui: GUI, sshOk, cloudInit, cuaInstalled, cuaActive, bootstrapStatus, bootstrapTail, ts: Date.now() };
}

// Cache + single-flight so polling doesn't spawn an SSH storm.
let cache = null;
let cacheAt = 0;
let inflight = null;
function getStatus() {
  if (cache && Date.now() - cacheAt < 4000) return Promise.resolve(cache);
  if (!inflight) {
    inflight = probe()
      .then((r) => {
        cache = r;
        cacheAt = Date.now();
        inflight = null;
        return r;
      })
      .catch(() => {
        inflight = null;
        return cache ?? { gui: GUI, sshOk: false, cloudInit: "unknown" };
      });
  }
  return inflight;
}

http
  .createServer(async (req, res) => {
    if (req.url === "/status" || req.url === "/" || req.url === "/healthz") {
      const s = await getStatus();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(s));
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(PORT, "0.0.0.0", () => console.log(`[status-server] listening on :${PORT}`));
