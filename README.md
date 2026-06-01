# agents

Container images + shared tooling for the **AI daemon** that controls a tenant's
KubeVirt VM (shell over SSH, plus screen control on desktops) and is driveable
from the livellm.cloud UI.

This repo ships the **engine image and the tooling it carries**. The
orchestration — provisioning the per-VM daemon, generating its SSH key, writing
its config Secret, and proxying the chat — lives in the platform
(`tenant-operator` renders `charts/agents`; `tenant-api` does keygen + Secrets +
the chat/status proxy). There is **no separate controller or operator here**: a
daemon is one `opencode serve` pod per VM, and a future "master" is just another
engine pointed at other engines (orchestrator-daemon, not a new service).

## Layout

| Path | What |
| --- | --- |
| `engines/opencode/` | The daemon image: `opencode serve` on :4096, the `fleet` wrapper, the one-time VM bootstrap (`agent-bootstrap`), and the guest-status server on :4097. Tag `opencode-<v>`. |
| `engines/claude/` | Claude-engine variant (WIP). |
| `shared/` | `fleet` (the agent's SSH/cua interface to its VM), `agent-bootstrap` (ssh-copy-id + cua install over SSH), `entrypoint.sh`, `status-server.mjs`, `AGENTS.md.tmpl`. |

## How the daemon controls its VM

```
aidaemon pod                         the VM (guest)
  opencode serve :4096   ── SSH ─▶   sshd
  status-server :4097    ── SSH ─▶   cloud-init / cua probes
  agent + fleet          ── SSH ─▶   cua-computer-server :8000 (desktops)
```

opencode runs **in the pod**, never on the VM. The agent's shell tool runs
`fleet run|push|pull|screenshot vm …`, which SSHes into the VM. The VM only ever
gets `sshd` and (on desktops) `cua-computer-server`, installed by the bootstrap.
The cua `/cmd` schema (cua-computer-server 0.3.39): `{"command","params"}`, SSE
reply (`data: {json}`), screenshot in `image_data`; loopback, no auth.

## Local smoke test

```
docker compose up --build      # builds + runs the engine image on :4096
```

## Versioning & CI

Each engine carries a `version.toml`; pushing a change under `engines/<name>/**`
builds + pushes `kamasalyamov/agents:<name>-<version>` (+ `-latest`) via the
reusable `.github/workflows/_docker.yml`.
