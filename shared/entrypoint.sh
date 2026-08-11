#!/bin/sh
# Engine entrypoint — shared by the opencode, claude and codex engines
# (AGENT_ENGINE selects; it defaults to whichever binary is present). When the engine is
# acting as a per-VM AI daemon
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
PROVIDER_KEY=""
if [ -f "$AUTH" ] && command -v jq >/dev/null 2>&1; then
  PROVIDER_KEY=$(jq -r 'to_entries[0].value.key // empty' "$AUTH" 2>/dev/null || true)
  [ -n "$PROVIDER_KEY" ] && export Z_AI_API_KEY="$PROVIDER_KEY"
fi

# opencode GLOBAL config at ~/.config/opencode/opencode.jsonc (the location the
# served daemon actually loads). This is a headless server — there is no human
# to answer opencode's permission prompts, so allow all tool use, otherwise the
# agent hangs waiting for an approval that never arrives. Add the zai vision MCP
# server when the chosen provider has it enabled; the key is inlined from the
# mounted auth.json (tenant-api cannot read the Secret back to render it).
mkdir -p /root/.config/opencode /workspace/outbox

# Compose the MCP block. The "bridge" server (ask_human + the outbox the chat
# shows as attachments) is loaded in BOTH roles. On top of it: "fleet" for a
# master (drive slave daemons) or the zai vision MCP for a daemon (when on).
BRIDGE_MCP='"bridge": { "type": "local", "command": ["node", "/usr/local/bin/bridge-mcp.mjs"] }'
if [ -f /etc/aimaster/targets.json ]; then
  EXTRA_MCP='"fleet": { "type": "local", "command": ["node", "/usr/local/bin/fleet-mcp.mjs"], "environment": { "FLEET_TARGETS": "/etc/aimaster/targets.json" } }'
elif [ -f /etc/aidaemon/mcp_vision ] && [ -n "${Z_AI_API_KEY:-}" ]; then
  EXTRA_MCP='"zai-mcp-server": { "type": "local", "command": ["npx", "-y", "@z_ai/mcp-server"], "environment": { "Z_AI_API_KEY": "'"${Z_AI_API_KEY}"'", "Z_AI_MODE": "ZAI" } }'
else
  EXTRA_MCP=''
fi
if [ -n "$EXTRA_MCP" ]; then MCP="$BRIDGE_MCP, $EXTRA_MCP"; else MCP="$BRIDGE_MCP"; fi
cat > /root/.config/opencode/opencode.jsonc <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "permission": { "*": "allow" },
  "tools": { "question": false },
  "plugin": ["file:///usr/local/bin/supervise-plugin.mjs"],
  "mcp": { $MCP }
}
EOF

# Both helpers below start with `( … & )`, not a plain `&`. The final line execs
# opencode *in place*, so this shell's PID becomes opencode's — a plain `&` would
# leave these as direct children of a process that never wait()s on them, and
# each would sit <defunct> for the life of the pod. The subshell exits
# immediately, orphaning the helper to PID 1 (tini, per the Dockerfile
# ENTRYPOINT), which reaps it properly.

# agent-bridge on :4097 — status (daemon), the outbox attachments tray, and the
# ask_human pending-question store. Runs in both roles.
( node /usr/local/bin/status-server.mjs >/tmp/status-server.log 2>&1 & )

if [ -f /etc/aidaemon/vm_user ]; then
  echo "[entrypoint] AI daemon mode — bootstrapping VM in background"
  ( agent-bootstrap >/tmp/agent-bootstrap.log 2>&1 & )
fi

# ── engine dispatch ────────────────────────────────────────────────────────
# claude: the CLI has no server mode, so claude-shim exposes the same HTTP
# subset tenant-api drives (see engines/claude/shim.mjs). Tools are the same
# stdio MCP servers, passed as --mcp-config instead of opencode.jsonc.
ENGINE="${AGENT_ENGINE:-}"
if [ -z "$ENGINE" ]; then
  if command -v opencode >/dev/null 2>&1; then ENGINE=opencode; else ENGINE=claude; fi
fi

if [ "$ENGINE" = "claude" ]; then
  # Same MCP servers, Claude's config shape. mcpServers entries are
  # {command,args,env}; allowedTools must name each tool as mcp__<srv>__<tool>.
  MCP_SERVERS='"bridge": { "command": "node", "args": ["/usr/local/bin/bridge-mcp.mjs"] }'
  ALLOWED='mcp__bridge__ask_human,mcp__bridge__share_file'
  if [ -f /etc/aimaster/targets.json ]; then
    MCP_SERVERS="$MCP_SERVERS, \"fleet\": { \"command\": \"node\", \"args\": [\"/usr/local/bin/fleet-mcp.mjs\"], \"env\": { \"FLEET_TARGETS\": \"/etc/aimaster/targets.json\" } }"
    ALLOWED="$ALLOWED,mcp__fleet__list_agents,mcp__fleet__delegate,mcp__fleet__check,mcp__fleet__answer_agent,mcp__fleet__review_agent,mcp__fleet__collect_file,mcp__fleet__schedule_loop,mcp__fleet__list_loops,mcp__fleet__toggle_loop"
  fi
  # Auth comes from the SAME provider Secret the opencode engine mounts, so no
  # chart change is needed. Which env var depends on the credential kind, and
  # the token prefix says which: `claude setup-token` (a Pro/Max subscription)
  # issues sk-ant-oat…, a plain API key is sk-ant-api… The CLI reads
  # CLAUDE_CODE_OAUTH_TOKEN for the former and ANTHROPIC_API_KEY for the latter.
  if [ -n "$PROVIDER_KEY" ]; then
    case "$PROVIDER_KEY" in
      sk-ant-oat*) export CLAUDE_CODE_OAUTH_TOKEN="$PROVIDER_KEY" ;;
      *) export ANTHROPIC_API_KEY="$PROVIDER_KEY" ;;
    esac
  fi
  # The auth.json top-level key IS the connected provider id — the shim echoes
  # it from /config/providers so the chat's model picker matches by id.
  CLAUDE_PROVIDER_ID=$(jq -r 'keys[0] // empty' "$AUTH" 2>/dev/null || true)
  export CLAUDE_PROVIDER_ID="${CLAUDE_PROVIDER_ID:-claude-subscription}"
  mkdir -p /data/shim
  printf '{ "mcpServers": { %s } }' "$MCP_SERVERS" > /root/claude-mcp.json
  export CLAUDE_MCP_CONFIG=/root/claude-mcp.json
  # Built-in tools stay enabled; only MCP tools need explicit allow-listing.
  export CLAUDE_ALLOWED_TOOLS="$ALLOWED"
  [ -f /etc/aidaemon/model ] && export CLAUDE_MODEL="$(cat /etc/aidaemon/model)"
  [ -f /etc/aimaster/model ] && export CLAUDE_MODEL="$(cat /etc/aimaster/model)"
  exec node /usr/local/bin/claude-shim.mjs
fi

if [ "$ENGINE" = "codex" ]; then
  # codex reads MCP servers + policies from CODEX_HOME/config.toml. CODEX_HOME
  # is on the data volume (Dockerfile): the CLI refreshes subscription tokens
  # in auth.json, so unlike claude the credential must be writable.
  CODEX_HOME="${CODEX_HOME:-/data/codex}"
  export CODEX_HOME
  mkdir -p "$CODEX_HOME" /data/shim
  {
    echo '[mcp_servers.bridge]'
    echo 'command = "node"'
    echo 'args = ["/usr/local/bin/bridge-mcp.mjs"]'
    if [ -f /etc/aimaster/targets.json ]; then
      echo '[mcp_servers.fleet]'
      echo 'command = "node"'
      echo 'args = ["/usr/local/bin/fleet-mcp.mjs"]'
      echo '[mcp_servers.fleet.env]'
      echo 'FLEET_TARGETS = "/etc/aimaster/targets.json"'
    fi
  } > "$CODEX_HOME/config.toml"
  # Auth from the SAME provider Secret every engine mounts. Two shapes:
  #   sk-…       an OpenAI API key → env + auth.json
  #   {…}        a pasted codex auth file (ChatGPT subscription: the user runs
  #              `codex login` on their machine and pastes ~/.codex/auth.json)
  if [ -n "$PROVIDER_KEY" ]; then
    case "$PROVIDER_KEY" in
      "{"*) printf '%s' "$PROVIDER_KEY" > "$CODEX_HOME/auth.json" ;;
      *)
        export OPENAI_API_KEY="$PROVIDER_KEY"
        printf '{ "OPENAI_API_KEY": "%s" }' "$PROVIDER_KEY" > "$CODEX_HOME/auth.json"
        ;;
    esac
    chmod 600 "$CODEX_HOME/auth.json" 2>/dev/null || true
  fi
  # The auth.json top-level key IS the connected provider id — the shim echoes
  # it from /config/providers so the chat's model picker matches by id.
  CODEX_PROVIDER_ID=$(jq -r 'keys[0] // empty' "$AUTH" 2>/dev/null || true)
  export CODEX_PROVIDER_ID="${CODEX_PROVIDER_ID:-chatgpt-subscription}"
  [ -f /etc/aidaemon/model ] && export CODEX_MODEL="$(cat /etc/aidaemon/model)"
  [ -f /etc/aimaster/model ] && export CODEX_MODEL="$(cat /etc/aimaster/model)"
  exec node /usr/local/bin/codex-shim.mjs
fi

exec opencode serve --hostname 0.0.0.0 --port 4096
