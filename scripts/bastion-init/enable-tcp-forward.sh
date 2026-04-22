#!/usr/bin/with-contenv bash
# linuxserver/openssh-server ships with AllowTcpForwarding disabled. Re-enable
# it so this bastion can actually jump to the DB network. Runs on every init
# via the /custom-cont-init.d/ hook, after the image has written its default
# sshd_config from a template but before sshd itself starts.
set -e
CONF=/config/sshd/sshd_config
if [ -f "$CONF" ]; then
  sed -i 's/^AllowTcpForwarding.*/AllowTcpForwarding yes/' "$CONF"
  grep -q '^AllowTcpForwarding yes' "$CONF" || echo 'AllowTcpForwarding yes' >> "$CONF"
  echo "[bastion-init] AllowTcpForwarding enabled"
fi
