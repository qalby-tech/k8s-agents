#!/bin/sh
# Engine entrypoint. When this opencode engine is acting as a per-VM AI daemon
# (the <res>-aidaemon Secret is mounted at /etc/aidaemon), run the one-time VM
# bootstrap in the background — so the opencode API is up immediately while the
# daemon installs its key + cua on the VM. Standalone engines (no /etc/aidaemon)
# just serve.
set -e

if [ -f /etc/aidaemon/vm_user ]; then
  echo "[entrypoint] AI daemon mode — bootstrapping VM in background"
  agent-bootstrap >/tmp/agent-bootstrap.log 2>&1 &
fi

exec opencode serve --hostname 0.0.0.0 --port 4096
