#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y \
  chrony \
  curl \
  iperf3 \
  iproute2 \
  iputils-ping \
  jq \
  mtr-tiny \
  python3 \
  tcpdump \
  wireguard-tools

systemctl enable --now chrony
chronyc waitsync 20 0.1 || true

install -d -m 0755 /opt/hyperspace-testnodes

echo "testnode prepared"
chronyc tracking || true
