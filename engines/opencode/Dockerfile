# opencode engine — `opencode serve` on :4096 + the `fleet` wrapper.
# Build context = repo root (CI passes context: .) so it can pull in shared/.
FROM node:22-slim

# git: opencode repo/snapshot ops. curl: healthcheck. openssh-client + jq: `fleet`
# (drives the target fleet over SSH; jq builds/parses cua /cmd).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl openssh-client jq \
    && rm -rf /var/lib/apt/lists/*

# Pin opencode so engine + controller stay in lockstep.
ARG OPENCODE_VERSION=1.15.12
RUN npm install -g opencode-ai@${OPENCODE_VERSION}

# fleet wrapper — the agent's sole interface to its targets (SSH shell + cua GUI).
COPY shared/fleet/fleet /usr/local/bin/fleet
RUN chmod +x /usr/local/bin/fleet

WORKDIR /workspace

# Credentials at opencode's default path; mounted via Secret (k8s) / bind (compose).
ENV OPENCODE_DATA=/root/.local/share/opencode

# Default fleet instructions opencode auto-reads; operator overrides per namespace
# (along with /etc/fleet/targets.json + ~/.ssh/config).
COPY shared/AGENTS.md.tmpl /workspace/AGENTS.md

EXPOSE 4096
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
