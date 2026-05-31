# ssh_sidecar — minimal hardened sshd injected next to a pod workload to make it a
# "terminal" fleet target. The fleet daemon connects here over SSH :22.
#
# Keys are operator-managed (mounted), NOT baked, so:
#   * authorized_keys  = the fleet daemon's PUBLIC key (read-only Secret/projected)
#   * host key         = a per-target key the operator generates and PINS in the
#                        daemon's known_hosts (MITM defense). Falls back to a
#                        self-generated key only when none is mounted (dev only).
#
# To give the agent access to the WORKLOAD container's processes/filesystem (not
# just this sidecar), set `shareProcessNamespace: true` on the pod and share the
# relevant volumes — see ssh-sidecar.patch.yaml.
FROM alpine:3.20

RUN apk add --no-cache openssh-server \
    && adduser -D -s /bin/sh agent \
    && mkdir -p /home/agent/.ssh && chmod 700 /home/agent/.ssh \
    && chown -R agent:agent /home/agent/.ssh \
    # key-only, no root, no passwords
    && sed -i \
       -e 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' \
       -e 's/^#\?PermitRootLogin.*/PermitRootLogin no/' \
       -e 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' \
       /etc/ssh/sshd_config

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
