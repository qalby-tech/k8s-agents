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

# MCP vision: when the chosen provider has it enabled (a marker in the daemon
# Secret) and we have the key, write opencode's GLOBAL config declaring the zai
# vision MCP server. It must live at ~/.config/opencode/opencode.jsonc — a
# project-dir opencode.json is not reliably loaded by the served daemon. The key
# is inlined here (the entrypoint can read the mounted auth.json; tenant-api
# cannot read the Secret back). 'read' is disabled so a text model can't try to
# read a screenshot as an image and hang on it — it must use the MCP tool.
if [ -f /etc/aidaemon/mcp_vision ] && [ -n "${Z_AI_API_KEY:-}" ]; then
  mkdir -p /root/.config/opencode
  cat > /root/.config/opencode/opencode.jsonc <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "mcp": {
    "zai-mcp-server": {
      "type": "local",
      "command": ["npx", "-y", "@z_ai/mcp-server"],
      "environment": {
        "Z_AI_API_KEY": "${Z_AI_API_KEY}",
        "Z_AI_MODE": "ZAI"
      }
    }
  },
  "tools": { "read": false }
}
EOF
fi

if [ -f /etc/aidaemon/vm_user ]; then
  echo "[entrypoint] AI daemon mode — bootstrapping VM in background"
  agent-bootstrap >/tmp/agent-bootstrap.log 2>&1 &
fi

exec opencode serve --hostname 0.0.0.0 --port 4096
