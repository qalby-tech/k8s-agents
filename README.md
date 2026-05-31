# k8s-agents

Control Kubernetes pods and KubeVirt VMs as AI agents. An **operator** provisions,
per namespace, one **AI daemon** (an opencode-based **engine**) that reaches a fleet
of tightened targets over **SSH** — terminal pods and GUI desktops alike — and a
**controller** accepts tasks and drives the engines.

Part of the `livellm.cloud` platform ("AI agent service").

## Architecture

```
            task (REST)
                │
          ┌───────────┐        @opencode-ai/sdk
          │ controller │ ───────────────────────────┐
          └───────────┘                             ▼
   operator (per ns)                          ┌───────────┐
   provisions  ─────────────────────────────▶ │  engine   │  opencode serve :4096
   keys / daemon / targets / netpol           │  (daemon) │  + `fleet` wrapper
                                               └─────┬─────┘
                                  SSH :22 (shell) +  │  ssh <t> curl 127.0.0.1:8000/cmd (GUI)
                            ┌──────────────────┬─────┴───────────────┐
                            ▼                  ▼                     ▼
                     terminal pod        Ubuntu GUI VM        Windows GUI VM
                     (sshd sidecar)    (cua + autologin)    (cua + autologon)
```

- **One channel:** shell and GUI both ride SSH `:22`. The cua Computer Server stays
  bound to `127.0.0.1:8000` in the guest and is reached via `ssh <target> curl
  127.0.0.1:8000/cmd` — never exposed on the network; the SSH key is the only gate.
- **No MCP:** the agent drives targets through the `fleet` CLI (documented in
  `AGENTS.md`, which opencode auto-reads), invoked via its shell tool.

## Layout

| Path | What | Image tag |
|------|------|-----------|
| `operator/` | Go operator: `AgentFleet` CRD, reconcile, sidecar-injection webhook | `operator-<v>` |
| `controller/` | Node ESM: task intake + drives engines via the opencode SDK | `controller-<v>` |
| `engines/opencode/` | `opencode serve` + `fleet` wrapper | `opencode-<v>` |
| `engines/claude/` | Claude Code engine — **placeholder** (control shim TBD) | `claude-<v>` |
| `ssh-sidecar/` | Hardened sshd injected into terminal pods | `sshd-<v>` |
| `shared/fleet/` | The `fleet` wrapper + ssh_config/targets templates | — |
| `shared/AGENTS.md.tmpl` | Agent-facing fleet instructions | — |
| `templates/` | Provisioning: Ubuntu cloud-init, Windows sysprep, pod sidecar patch | — |

All images publish to a single Docker Hub repo **`kamasalyamov/agents`** with
project-prefixed tags (e.g. `kamasalyamov/agents:opencode-0.1.0`).

## Versioning & CI

Each project carries `version.toml` (`version = "0.1.0"`). On push to `main`, the
path-filtered GitHub Actions workflow for a changed project reads its version and
pushes `<prefix>-<version>` + `<prefix>-latest` (reusable `.github/workflows/_docker.yml`).
Bump a version.toml to cut a release.

## Local end-to-end

```bash
TEST_PROMPT="reply with the single word: pong" docker compose up --build \
  --abort-on-container-exit --exit-code-from controller
```

## The `fleet` interface (what the agent uses)

```
fleet run  <name> <cmd...>          # shell on a target (SSH ControlMaster, reused)
fleet screenshot <name> <out.png>   # GUI: capture (via in-guest cua /cmd over SSH)
fleet gui  <name> click <x> <y>     # GUI: click / type / key / scroll / hotkey
```

The cua `/cmd` schema (verified against `cua-computer-server` 0.3.39): envelope
`{"command","params"}`, SSE reply (`data: {json}`), screenshot in `image_data`;
no auth on a self-hosted loopback server.

## Status

- ✅ `fleet` wrapper, opencode engine image, controller, ssh-sidecar image
- ✅ Ubuntu GUI cloud-init, pod sidecar injection patch
- ✅ CI (per-project, version.toml → Docker Hub)
- 🚧 operator reconcile logic (skeleton compiles; phase-6 TODOs in the reconciler)
- 🚧 Windows sysprep template
- 🚧 `claude` engine (control shim)
