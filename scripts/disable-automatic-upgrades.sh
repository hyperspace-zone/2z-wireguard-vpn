#!/usr/bin/env bash
set -euo pipefail

APT_POLICY_FILE="${HYPERSPACE_APT_POLICY_FILE:-/etc/apt/apt.conf.d/99-hyperspace-disable-periodic-upgrades}"

install -d -m 0755 "$(dirname "$APT_POLICY_FILE")"
install -m 0644 /dev/stdin "$APT_POLICY_FILE" <<'EOF'
APT::Periodic::Enable "0";
APT::Periodic::Update-Package-Lists "0";
APT::Periodic::Download-Upgradeable-Packages "0";
APT::Periodic::AutocleanInterval "0";
APT::Periodic::Unattended-Upgrade "0";
EOF

systemctl disable --now apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
systemctl mask apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true

# Mask future activation without terminating an apt/dpkg transaction that may
# already be running. Operators must let any active package transaction finish.
systemctl mask apt-daily.service apt-daily-upgrade.service 2>/dev/null || true

systemctl stop unattended-upgrades.service 2>/dev/null || true
systemctl disable unattended-upgrades.service 2>/dev/null || true
systemctl mask unattended-upgrades.service 2>/dev/null || true

systemctl reset-failed \
  apt-daily.timer \
  apt-daily-upgrade.timer \
  apt-daily.service \
  apt-daily-upgrade.service \
  unattended-upgrades.service 2>/dev/null || true

if pgrep -x apt >/dev/null \
  || pgrep -x apt-get >/dev/null \
  || pgrep -x dpkg >/dev/null \
  || pgrep -f '/usr/lib/apt/apt-helper' >/dev/null \
  || pgrep -f '/usr/bin/unattended-upgrade' >/dev/null; then
  printf 'automatic upgrades disabled; an existing package transaction is still running and must be allowed to finish\n' >&2
  exit 2
fi

printf 'automatic APT updates disabled; use an explicit maintenance window for package updates\n'
