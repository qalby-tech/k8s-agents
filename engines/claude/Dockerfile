# claude engine — Claude Code CLI in headless mode behind claude-shim, which
# speaks the same HTTP subset tenant-api drives on opencode (:4096). Same
# tools, same fleet wrapper, same AGENTS.md; only the brain differs.
#
# Why an engine and not a gateway: a Claude Pro/Max subscription can only be
# used by the first-party CLI, so BYO-subscription means running the real thing
# in the workspace pod. Auth is a long-lived token from `claude setup-token`,
# mounted read-only (verified: the CLI does not rewrite it).
#
# Build context = repo root (CI passes context: .) so it can pull in shared/.
FROM node:22-slim

# Same toolbelt as the opencode engine — the agent's shell tool expects it:
# git, curl, openssh-client + jq + sshpass (fleet/SSH bootstrap), db clients,
# tini for PID 1 reaping (ssh ControlPersist masters orphan by design).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl openssh-client jq sshpass postgresql-client redis-tools tini \
    && rm -rf /var/lib/apt/lists/*

# helm — read-only reference for deploying known apps (never installs).
RUN curl -fsSL https://get.helm.sh/helm-v3.16.3-linux-amd64.tar.gz \
    | tar -xzO linux-amd64/helm > /usr/local/bin/helm \
    && chmod +x /usr/local/bin/helm

# Pin the CLI: it moves fast and the shim parses its stream-json events.
ARG CLAUDE_CODE_VERSION=2.1.221
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# The shim: opencode-compatible HTTP over the headless CLI.
COPY engines/claude/shim.mjs /usr/local/bin/claude-shim.mjs
# Shared agent surface — identical to the opencode engine. The MCP servers ARE
# the tools: bridge-mcp (ask_human/share_file), fleet-mcp (master
# orchestration), db-admin (storage daemons). All stdio MCP, which the Claude
# CLI speaks natively (verified in the P0 spike).
COPY shared/fleet/fleet /usr/local/bin/fleet
COPY shared/agent-bootstrap /usr/local/bin/agent-bootstrap
COPY shared/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY shared/status-server.mjs /usr/local/bin/status-server.mjs
COPY shared/db-admin.mjs /usr/local/bin/db-admin.mjs
COPY shared/fleet-mcp.mjs /usr/local/bin/fleet-mcp.mjs
COPY shared/bridge-mcp.mjs /usr/local/bin/bridge-mcp.mjs
RUN chmod +x /usr/local/bin/fleet /usr/local/bin/agent-bootstrap /usr/local/bin/entrypoint.sh

WORKDIR /workspace

# Session state on the data volume so chats survive restarts.
ENV CLAUDE_SHIM_STATE=/data/shim \
    CLAUDE_SHIM_WORKDIR=/workspace \
    SHIM_PORT=4096
# The CLI reads instructions from CLAUDE.md; the platform writes AGENTS.md.
COPY shared/AGENTS.md.tmpl /workspace/AGENTS.md
RUN ln -sf /workspace/AGENTS.md /workspace/CLAUDE.md

EXPOSE 4096 4097
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]
