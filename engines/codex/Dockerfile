# codex engine — the OpenAI Codex CLI in exec mode behind codex-shim, which
# speaks the same HTTP subset tenant-api drives on opencode (:4096). Same
# tools, same fleet wrapper, same AGENTS.md; only the brain differs.
#
# Why an engine and not a gateway: a ChatGPT Plus/Pro subscription can only be
# used by the first-party CLI, so BYO-subscription means running the real thing
# in the workspace pod — the exact argument the claude engine was built on.
# Auth lands in CODEX_HOME/auth.json, which lives on the DATA volume (not a
# read-only Secret mount): unlike the Claude CLI, codex refreshes subscription
# tokens in place and must be able to write the file.
#
# Build context = repo root (CI passes context: .) so it can pull in shared/.
FROM node:22-slim

# Same toolbelt as the other engines — the agent's shell tool expects it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl openssh-client jq sshpass postgresql-client redis-tools tini \
    && rm -rf /var/lib/apt/lists/*

# helm — read-only reference for deploying known apps (never installs).
RUN curl -fsSL https://get.helm.sh/helm-v3.16.3-linux-amd64.tar.gz \
    | tar -xzO linux-amd64/helm > /usr/local/bin/helm \
    && chmod +x /usr/local/bin/helm

# Pin the CLI: it moves fast and the shim parses its --json events
# (thread.started / item.* / turn.failed — probed against exactly this build).
ARG CODEX_VERSION=0.147.0
RUN npm install -g @openai/codex@${CODEX_VERSION}

# The shim: opencode-compatible HTTP over codex exec.
COPY engines/codex/shim.mjs /usr/local/bin/codex-shim.mjs
# Shared agent surface — identical to the other engines. The MCP servers ARE
# the tools; codex speaks stdio MCP via CODEX_HOME/config.toml (written by the
# entrypoint).
COPY shared/fleet/fleet /usr/local/bin/fleet
COPY shared/agent-bootstrap /usr/local/bin/agent-bootstrap
COPY shared/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY shared/status-server.mjs /usr/local/bin/status-server.mjs
COPY shared/db-admin.mjs /usr/local/bin/db-admin.mjs
COPY shared/fleet-mcp.mjs /usr/local/bin/fleet-mcp.mjs
COPY shared/bridge-mcp.mjs /usr/local/bin/bridge-mcp.mjs
RUN chmod +x /usr/local/bin/fleet /usr/local/bin/agent-bootstrap /usr/local/bin/entrypoint.sh

WORKDIR /workspace

# Session state on the data volume so chats survive restarts. CODEX_HOME too:
# auth.json (token refresh) and config.toml both need a writable home.
ENV AGENT_ENGINE=codex \
    CODEX_SHIM_STATE=/data/shim \
    CODEX_SHIM_WORKDIR=/workspace \
    CODEX_HOME=/data/codex \
    SHIM_PORT=4096
# codex reads instructions from AGENTS.md natively — no symlink needed.
COPY shared/AGENTS.md.tmpl /workspace/AGENTS.md

EXPOSE 4096 4097
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]
