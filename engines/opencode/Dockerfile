# opencode engine — `opencode serve` on :4096 + the `fleet` wrapper.
# Build context = repo root (CI passes context: .) so it can pull in shared/.
FROM node:22-slim

# git: opencode repo/snapshot ops. curl: healthcheck. openssh-client + jq: `fleet`
# (drives the target fleet over SSH; jq builds/parses cua /cmd). sshpass: the
# one-time ssh-copy-id bootstrap onto the VM using its password.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl openssh-client jq sshpass \
    && rm -rf /var/lib/apt/lists/*

# Pin opencode so engine + controller stay in lockstep.
ARG OPENCODE_VERSION=1.15.12
RUN npm install -g opencode-ai@${OPENCODE_VERSION}

# fleet wrapper — the agent's sole interface to its targets (SSH shell + cua GUI).
# agent-bootstrap + entrypoint: when run as a per-VM daemon, install the daemon's
# key + cua on the VM over SSH, then serve.
COPY shared/fleet/fleet /usr/local/bin/fleet
COPY shared/agent-bootstrap /usr/local/bin/agent-bootstrap
COPY shared/entrypoint.sh /usr/local/bin/entrypoint.sh
# status-server: guest-status endpoint (:4097) the UI polls (cloud-init/cua/ssh).
COPY shared/status-server.mjs /usr/local/bin/status-server.mjs
RUN chmod +x /usr/local/bin/fleet /usr/local/bin/agent-bootstrap /usr/local/bin/entrypoint.sh

WORKDIR /workspace

# Credentials at opencode's default path; mounted via Secret (k8s) / bind (compose).
ENV OPENCODE_DATA=/root/.local/share/opencode

# Default fleet instructions opencode auto-reads; operator overrides per namespace
# (along with /etc/fleet/targets.json + ~/.ssh/config).
COPY shared/AGENTS.md.tmpl /workspace/AGENTS.md

EXPOSE 4096 4097
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
