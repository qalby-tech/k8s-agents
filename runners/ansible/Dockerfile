# ansible runner — applies a VM's state repo to the VM over SSH.
#
# Not an engine: no model, no shim, no chat. tenant-api runs this as a one-shot
# Job in the tenant's namespace when someone pushes to a VM's state repo. The
# Job mounts the VM's aidaemon Secret, which already carries both halves of
# what an apply needs: the SSH key the daemon uses, and the workspace git
# credential to clone the repo.
#
# Build context = repo root (CI passes context: .), matching the engines.
FROM python:3.12-slim

# openssh-client: the transport. sshpass: first-apply key bootstrap (same
# ssh-copy-id dance as shared/agent-bootstrap, so an apply works even if the
# daemon has never connected). git: fetch the state repo. tini: PID 1.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       git ca-certificates openssh-client sshpass tini \
    && rm -rf /var/lib/apt/lists/*

# Pinned: an apply must be reproducible — the same commit applied twice, weeks
# apart, must behave identically.
ARG ANSIBLE_VERSION=11.1.0
RUN pip install --no-cache-dir "ansible==${ANSIBLE_VERSION}"

COPY runners/ansible/apply.sh /usr/local/bin/apply.sh
RUN chmod +x /usr/local/bin/apply.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/apply.sh"]
