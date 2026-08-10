#!/usr/bin/env bash
#
# apply.sh — fetch a VM's state repo at a given commit and converge the VM to it.
#
# Everything comes from env + the mounted aidaemon Secret; the Job that runs
# this is created by tenant-api on a push to <vm>-state, or when a machine is
# rebuilt and has to be brought back to what its repo says it is:
#
#   GIT_REPO_URL   in-cluster clone URL (http://gitea-http…/<org>/<vm>-state.git)
#   GIT_USER       workspace git bot user     (from the Secret)
#   GIT_TOKEN      its token                  (from the Secret)
#   COMMIT         the exact sha to apply
#   VM_HOST        the VM's in-cluster DNS name
#   VM_USER        login user                 (from the Secret)
#   VM_PASSWORD    login password             (from the Secret — key bootstrap only)
#   SSH_KEY        path to the private key    (mounted, 0400)
#   PLAN_ONLY      "1" → --check --diff, change nothing (preview / drift check)
#   COLD_BOOT      "1" → the machine is brand new: wait out first boot
#   WAIT_SECS      how long to wait for the machine to accept the key (200)
#   PW_GRACE_SECS  how long to tolerate a rejected password before giving up (60)
#
# Exit codes are the Job's verdict: 0 converged, non-zero surfaced to the user.
set -euo pipefail

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

: "${GIT_REPO_URL:?}" "${COMMIT:?}" "${VM_HOST:?}" "${VM_USER:?}"
SSH_KEY="${SSH_KEY:-/etc/apply/id_ed25519_fleet}"
[ -f "$SSH_KEY" ] || die "no SSH key at $SSH_KEY"

# The mounted key is read-only 0400 in the Secret volume; ssh also wants it not
# group/world readable — copy to a private path we own.
install -m 0700 -d /root/.ssh
install -m 0600 "$SSH_KEY" /root/.ssh/id_apply
KEY=/root/.ssh/id_apply

# ── 1. Fetch the exact commit ──────────────────────────────────────────────
# Fetch by sha rather than clone-a-branch: a superseding push must not change
# what THIS job applies, and the Job's identity is its commit.
log "fetching ${COMMIT:0:7} from the state repo…"
mkdir -p /work && cd /work && git init -q .
AUTH_URL="$GIT_REPO_URL"
if [ -n "${GIT_USER:-}" ] && [ -n "${GIT_TOKEN:-}" ]; then
  # Credentials in the URL only — never written to disk, never logged.
  AUTH_URL=$(printf '%s' "$GIT_REPO_URL" | sed -E "s#^http://#http://${GIT_USER}:${GIT_TOKEN}@#")
fi
git fetch -q --depth 1 "$AUTH_URL" "$COMMIT" 2>/dev/null || die "cannot fetch $COMMIT — is the state repo reachable?"
git checkout -q FETCH_HEAD
[ -f site.yml ] || die "the state repo has no site.yml at its root"

# ── 2. Make sure we can log in ─────────────────────────────────────────────
# The daemon normally installs this key at startup, but an apply must not
# depend on the daemon ever having run — and on a rebuild it certainly hasn't:
# the machine is minutes old and the repo is being replayed onto it. Same
# ssh-copy-id dance as the daemon's bootstrap, bounded by wall time rather than
# attempt count so a slow first boot doesn't read as a failure.
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 -o BatchMode=yes"
WAIT_SECS="${WAIT_SECS:-200}"
PW_GRACE_SECS="${PW_GRACE_SECS:-60}"

if ! ssh $SSH_OPTS -i "$KEY" "$VM_USER@$VM_HOST" true 2>/dev/null; then
  log "key not accepted yet — installing it on the machine (up to ${WAIT_SECS}s)…"
  [ -n "${VM_PASSWORD:-}" ] || die "the VM has not accepted the agent's key and no password is available to install it"
  ssh-keygen -y -f "$KEY" > /root/.ssh/id_apply.pub
  started=$SECONDS
  denied_since=0
  installed=0
  while [ $((SECONDS - started)) -lt "$WAIT_SECS" ]; do
    if err=$(sshpass -p "$VM_PASSWORD" ssh-copy-id -i /root/.ssh/id_apply.pub \
               -o StrictHostKeyChecking=accept-new -o PubkeyAuthentication=no \
               -o PreferredAuthentications=password -o ConnectTimeout=8 \
               "$VM_USER@$VM_HOST" 2>&1 >/dev/null); then
      installed=1
      break
    fi
    if printf '%s' "$err" | grep -qi 'permission denied'; then
      # SSH is up and answering but the password is refused. On a first boot
      # that's transient (cloud-init hasn't created the user yet); sustained,
      # it's a real credential problem and waiting the full budget only delays
      # a clear error.
      [ "$denied_since" -eq 0 ] && denied_since=$SECONDS
      if [ $((SECONDS - denied_since)) -ge "$PW_GRACE_SECS" ]; then
        die "the machine kept rejecting the login for ${PW_GRACE_SECS}s — check the VM password"
      fi
    else
      denied_since=0
    fi
    log "  waiting for the machine ($((SECONDS - started))s/${WAIT_SECS}s)…"
    sleep 10
  done
  [ "$installed" = 1 ] || die "the machine did not accept the agent's key within ${WAIT_SECS}s"
  ssh $SSH_OPTS -i "$KEY" "$VM_USER@$VM_HOST" true 2>/dev/null \
    || die "still cannot log in to the machine after installing the key"
fi

# ── 3. On a rebuild, let first boot finish ──────────────────────────────────
# cloud-init installs its own `packages:` list on a new machine. Ansible's apt
# would race it for the dpkg lock and the loser dies on lock timeout — so on a
# cold boot wait for first boot to report done before touching packages.
if [ "${COLD_BOOT:-}" = "1" ]; then
  log "new machine — waiting for first boot to finish…"
  timeout 900 ssh $SSH_OPTS -i "$KEY" "$VM_USER@$VM_HOST" \
    'command -v cloud-init >/dev/null 2>&1 && cloud-init status --wait >/dev/null 2>&1 || true' \
    || log "  first boot did not report done in time — applying anyway"
fi

# ── 4. Converge ────────────────────────────────────────────────────────────
# Inventory is generated, never committed: the repo describes the machine's
# desired state, not where the machine currently lives — so it stays valid
# when the VM is recreated.
printf 'vm ansible_host=%s ansible_user=%s ansible_ssh_private_key_file=%s\n' \
  "$VM_HOST" "$VM_USER" "$KEY" > /tmp/inventory

export ANSIBLE_HOST_KEY_CHECKING=False
export ANSIBLE_PYTHON_INTERPRETER=auto_silent
export ANSIBLE_SSH_ARGS="-o StrictHostKeyChecking=accept-new -o ControlMaster=auto -o ControlPersist=60s"
export ANSIBLE_STDOUT_CALLBACK=default

MODE=(); [ "${PLAN_ONLY:-}" = "1" ] && MODE=(--check --diff) && log "PREVIEW ONLY — no changes will be made"

log "applying ${COMMIT:0:7} to $VM_HOST…"
ansible-playbook -i /tmp/inventory "${MODE[@]}" site.yml

# Record what the machine is converged to, on the machine. A rebuild is only
# verifiable if the machine itself can say which commit it matches — and this
# marker dies with the disk, which is exactly the right lifetime.
if [ "${PLAN_ONLY:-}" != "1" ]; then
  ansible -i /tmp/inventory vm -b -m ansible.builtin.file \
    -a "path=/var/lib/livellm state=directory mode=0755" >/dev/null 2>&1 || true
  ansible -i /tmp/inventory vm -b -m ansible.builtin.copy \
    -a "content=$COMMIT dest=/var/lib/livellm/state-sha mode=0644" >/dev/null 2>&1 || true
fi

log "done."
