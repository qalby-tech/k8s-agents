#!/bin/sh
# sshd sidecar entrypoint.
#  * host key:        use the operator-mounted key if present; else self-generate
#                     (DEV ONLY — an unpinned ephemeral host key breaks known_hosts).
#  * authorized_keys: expected mounted at /etc/fleet/authorized_keys (the daemon's
#                     public key). Copied to agent's ~/.ssh with correct perms.
set -eu

HOSTKEY=/etc/ssh/ssh_host_ed25519_key
if [ ! -f "$HOSTKEY" ]; then
  echo "[sshd] WARNING: no mounted host key at $HOSTKEY — generating ephemeral (dev only)" >&2
  ssh-keygen -t ed25519 -f "$HOSTKEY" -N "" >/dev/null
fi
chmod 600 "$HOSTKEY"

AK=/etc/fleet/authorized_keys
if [ -f "$AK" ]; then
  install -o agent -g agent -m 600 "$AK" /home/agent/.ssh/authorized_keys
else
  echo "[sshd] ERROR: no authorized_keys mounted at $AK — refusing all logins" >&2
fi

exec /usr/sbin/sshd -D -e -h "$HOSTKEY"
