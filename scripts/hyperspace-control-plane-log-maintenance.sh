#!/usr/bin/env bash
set -euo pipefail

ROOT_MOUNT="${HYPERSPACE_LOG_MAINTENANCE_MOUNT:-/}"
SOFT_THRESHOLD_PERCENT="${HYPERSPACE_LOG_MAINTENANCE_SOFT_THRESHOLD_PERCENT:-80}"
EMERGENCY_THRESHOLD_PERCENT="${HYPERSPACE_LOG_MAINTENANCE_EMERGENCY_THRESHOLD_PERCENT:-95}"
JOURNAL_VACUUM_SIZE="${HYPERSPACE_LOG_MAINTENANCE_JOURNAL_VACUUM_SIZE:-256M}"
JOURNAL_VACUUM_TIME="${HYPERSPACE_LOG_MAINTENANCE_JOURNAL_VACUUM_TIME:-7d}"
LOCK_FILE="${HYPERSPACE_LOG_MAINTENANCE_LOCK_FILE:-/run/hyperspace-control-plane-log-maintenance.lock}"

SYSTEM_LOG_FILES=(
  /var/log/syslog
  /var/log/syslog.1
  /var/log/kern.log
  /var/log/kern.log.1
)

usage_percent() {
  df -P "$1" | awk 'NR == 2 {gsub(/%/, "", $5); print $5}'
}

available_bytes() {
  df -P -B1 "$1" | awk 'NR == 2 {print $4}'
}

vacuum_journal() {
  if ! command -v journalctl >/dev/null 2>&1; then
    return
  fi

  journalctl --rotate >/dev/null || true
  journalctl \
    --vacuum-size="$JOURNAL_VACUUM_SIZE" \
    --vacuum-time="$JOURNAL_VACUUM_TIME" >/dev/null || true
}

rotate_logs() {
  if command -v logrotate >/dev/null 2>&1; then
    logrotate /etc/logrotate.conf >/dev/null 2>&1 || true
  fi
}

run_soft_cleanup() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get clean >/dev/null || true
  fi

  if command -v logrotate >/dev/null 2>&1; then
    logrotate -f /etc/logrotate.conf >/dev/null 2>&1 || true
  fi
}

run_emergency_cleanup() {
  local path

  # Only truncate duplicated system log files. Application state, PostgreSQL,
  # Hyperspace configuration, and the persistent journal are not touched.
  for path in "${SYSTEM_LOG_FILES[@]}"; do
    if [[ -f "$path" ]]; then
      : >"$path" || true
    fi
  done

  if systemctl list-unit-files rsyslog.service >/dev/null 2>&1; then
    systemctl reload-or-restart rsyslog.service >/dev/null 2>&1 || true
  fi
}

main() {
  local before_percent before_available after_percent after_available action

  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    printf 'hyperspace-control-plane-log-maintenance action=already-running\n'
    return
  fi

  before_percent="$(usage_percent "$ROOT_MOUNT")"
  before_available="$(available_bytes "$ROOT_MOUNT")"
  action="journal-vacuum"

  vacuum_journal
  after_percent="$(usage_percent "$ROOT_MOUNT")"
  if (( after_percent >= EMERGENCY_THRESHOLD_PERCENT )); then
    action="emergency-system-log-truncate"
    run_emergency_cleanup
    vacuum_journal
    if command -v apt-get >/dev/null 2>&1; then
      apt-get clean >/dev/null || true
    fi
  else
    rotate_logs
    after_percent="$(usage_percent "$ROOT_MOUNT")"
    if (( after_percent >= SOFT_THRESHOLD_PERCENT )); then
      action="soft-cleanup"
      run_soft_cleanup
    fi
  fi

  after_percent="$(usage_percent "$ROOT_MOUNT")"
  after_available="$(available_bytes "$ROOT_MOUNT")"
  printf 'hyperspace-control-plane-log-maintenance action=%s before_used_percent=%s after_used_percent=%s before_available_bytes=%s after_available_bytes=%s\n' \
    "$action" "$before_percent" "$after_percent" "$before_available" "$after_available"

  if (( after_percent >= EMERGENCY_THRESHOLD_PERCENT )); then
    printf 'root filesystem remains above emergency threshold (%s%%)\n' \
      "$EMERGENCY_THRESHOLD_PERCENT" >&2
    return 1
  fi
}

main "$@"
