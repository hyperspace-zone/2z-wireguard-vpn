#!/usr/bin/env bash
set -euo pipefail

ROOT_MOUNT="${HYPERSPACE_DISK_JANITOR_MOUNT:-/}"
SOFT_THRESHOLD_PERCENT="${HYPERSPACE_DISK_JANITOR_SOFT_THRESHOLD_PERCENT:-85}"
EMERGENCY_THRESHOLD_PERCENT="${HYPERSPACE_DISK_JANITOR_EMERGENCY_THRESHOLD_PERCENT:-95}"
JOURNAL_VACUUM_SIZE="${HYPERSPACE_DISK_JANITOR_JOURNAL_VACUUM_SIZE:-200M}"
METRICS_DIR="${HYPERSPACE_DISK_JANITOR_METRICS_DIR:-/var/lib/node_exporter/textfile_collector}"
STATE_DIR="${HYPERSPACE_DISK_JANITOR_STATE_DIR:-/var/lib/hyperspace-disk-janitor}"
METRICS_FILE="${METRICS_DIR}/hyperspace_disk_janitor.prom"
STATE_FILE="${STATE_DIR}/state"

LOG_FILES=(
  /var/log/syslog
  /var/log/syslog.1
  /var/log/kern.log
  /var/log/kern.log.1
)

usage_percent() {
  df -P -B1 "$ROOT_MOUNT" | awk 'NR == 2 {gsub(/%/, "", $5); print $5}'
}

avail_bytes() {
  df -P -B1 "$ROOT_MOUNT" | awk 'NR == 2 {print $4}'
}

load_runs_total() {
  if [[ -r "$STATE_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$STATE_FILE"
  fi
  printf '%s\n' "${runs_total:-0}"
}

save_runs_total() {
  install -d -m 0755 "$STATE_DIR"
  printf 'runs_total=%s\n' "$1" >"${STATE_FILE}.tmp"
  mv "${STATE_FILE}.tmp" "$STATE_FILE"
}

write_metrics() {
  local timestamp="$1"
  local before_percent="$2"
  local before_avail="$3"
  local after_percent="$4"
  local after_avail="$5"
  local action="$6"
  local success="$7"
  local runs_total_value="$8"

  install -d -m 0755 "$METRICS_DIR"
  {
    printf '# HELP hyperspace_gate_disk_janitor_last_run_timestamp_seconds Unix timestamp of the last gate disk janitor run.\n'
    printf '# TYPE hyperspace_gate_disk_janitor_last_run_timestamp_seconds gauge\n'
    printf 'hyperspace_gate_disk_janitor_last_run_timestamp_seconds %s\n' "$timestamp"
    printf '# HELP hyperspace_gate_disk_janitor_last_before_used_percent Root filesystem used percent before the last janitor run.\n'
    printf '# TYPE hyperspace_gate_disk_janitor_last_before_used_percent gauge\n'
    printf 'hyperspace_gate_disk_janitor_last_before_used_percent %s\n' "$before_percent"
    printf '# HELP hyperspace_gate_disk_janitor_last_after_used_percent Root filesystem used percent after the last janitor run.\n'
    printf '# TYPE hyperspace_gate_disk_janitor_last_after_used_percent gauge\n'
    printf 'hyperspace_gate_disk_janitor_last_after_used_percent %s\n' "$after_percent"
    printf '# HELP hyperspace_gate_disk_janitor_last_before_avail_bytes Root filesystem available bytes before the last janitor run.\n'
    printf '# TYPE hyperspace_gate_disk_janitor_last_before_avail_bytes gauge\n'
    printf 'hyperspace_gate_disk_janitor_last_before_avail_bytes %s\n' "$before_avail"
    printf '# HELP hyperspace_gate_disk_janitor_last_after_avail_bytes Root filesystem available bytes after the last janitor run.\n'
    printf '# TYPE hyperspace_gate_disk_janitor_last_after_avail_bytes gauge\n'
    printf 'hyperspace_gate_disk_janitor_last_after_avail_bytes %s\n' "$after_avail"
    printf '# HELP hyperspace_gate_disk_janitor_last_success Whether the last janitor run completed successfully.\n'
    printf '# TYPE hyperspace_gate_disk_janitor_last_success gauge\n'
    printf 'hyperspace_gate_disk_janitor_last_success %s\n' "$success"
    printf '# HELP hyperspace_gate_disk_janitor_last_action Last action performed by the janitor. One sample with value 1 is emitted.\n'
    printf '# TYPE hyperspace_gate_disk_janitor_last_action gauge\n'
    printf 'hyperspace_gate_disk_janitor_last_action{action="%s"} 1\n' "$action"
    printf '# HELP hyperspace_gate_disk_janitor_runs_total Total gate disk janitor runs on this host.\n'
    printf '# TYPE hyperspace_gate_disk_janitor_runs_total counter\n'
    printf 'hyperspace_gate_disk_janitor_runs_total %s\n' "$runs_total_value"
  } >"${METRICS_FILE}.tmp"
  mv "${METRICS_FILE}.tmp" "$METRICS_FILE"
}

run_soft_cleanup() {
  if command -v journalctl >/dev/null 2>&1; then
    journalctl --vacuum-size="$JOURNAL_VACUUM_SIZE" >/dev/null || true
  fi

  if command -v apt-get >/dev/null 2>&1; then
    apt-get clean >/dev/null || true
  fi

  if command -v logrotate >/dev/null 2>&1; then
    logrotate -f /etc/logrotate.conf >/dev/null 2>&1 || true
  fi
}

run_emergency_cleanup() {
  local path
  for path in "${LOG_FILES[@]}"; do
    if [[ -e "$path" ]]; then
      : >"$path" || true
    fi
  done

  if systemctl list-unit-files rsyslog.service >/dev/null 2>&1; then
    systemctl reload-or-restart rsyslog.service >/dev/null 2>&1 || true
  fi
}

main() {
  local timestamp before_percent before_avail after_percent after_avail action runs_total_value
  timestamp="$(date +%s)"
  before_percent="$(usage_percent)"
  before_avail="$(avail_bytes)"
  action="noop"

  runs_total_value="$(load_runs_total)"
  runs_total_value="$((runs_total_value + 1))"
  save_runs_total "$runs_total_value"

  if (( before_percent >= SOFT_THRESHOLD_PERCENT )); then
    action="soft_cleanup"
    run_soft_cleanup
  fi

  after_percent="$(usage_percent)"
  if (( after_percent >= EMERGENCY_THRESHOLD_PERCENT )); then
    action="emergency_cleanup"
    run_emergency_cleanup
  fi

  after_percent="$(usage_percent)"
  after_avail="$(avail_bytes)"
  write_metrics "$timestamp" "$before_percent" "$before_avail" "$after_percent" "$after_avail" "$action" 1 "$runs_total_value"

  printf 'hyperspace-disk-janitor action=%s mount=%s before_used_percent=%s before_avail_bytes=%s after_used_percent=%s after_avail_bytes=%s\n' \
    "$action" "$ROOT_MOUNT" "$before_percent" "$before_avail" "$after_percent" "$after_avail"
}

main "$@"
