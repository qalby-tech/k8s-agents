#!/bin/sh
# Engine entrypoint. When this opencode engine is acting as a per-VM AI daemon
# (the <res>-aidaemon Secret is mounted at /etc/aidaemon), run the one-time VM
# bootstrap in the background — so the opencode API is up immediately while the
# daemon installs its key + cua on the VM. Standalone engines (no /etc/aidaemon)
# just serve.
set -e

# Provider key for MCP servers (e.g. the zai vision MCP, which lets a text-only
# model "see" screenshots). The provider auth.json is mounted by the chart; we
# export the first provider's key as Z_AI_API_KEY so any MCP subprocess opencode
# spawns inherits it. This keeps the key out of any config file we'd otherwise
# have to render from a Secret tenant-api cannot read back.
AUTH=/root/.local/share/opencode/auth.json
if [ -f "$AUTH" ] && command -v jq >/dev/null 2>&1; then
  K=$(jq -r 'to_entries[0].value.key // empty' "$AUTH" 2>/dev/null || true)
  [ -n "$K" ] && export Z_AI_API_KEY="$K"
fi

# opencode project config (MCP servers) is delivered in the daemon Secret when
# the chosen provider has MCP vision enabled. Place it where opencode (cwd
# /workspace) loads it. opencode reads it once at serve start, so this must run
# before the exec below.
if [ -f /etc/aidaemon/opencode.json ]; then
  mkdir -p /workspace
  cp /etc/aidaemon/opencode.json /workspace/opencode.json
fi

if [ -f /etc/aidaemon/vm_user ]; then
  echo "[entrypoint] AI daemon mode — bootstrapping VM in background"
  agent-bootstrap >/tmp/agent-bootstrap.log 2>&1 &
fi

exec opencode serve --hostname 0.0.0.0 --port 4096
