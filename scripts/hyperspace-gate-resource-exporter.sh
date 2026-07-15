#!/usr/bin/env bash
set -euo pipefail

METRICS_DIR="${HYPERSPACE_GATE_RESOURCE_METRICS_DIR:-/var/lib/node_exporter/textfile_collector}"
METRICS_FILE="${METRICS_DIR}/hyperspace_gate_resources.prom"
DOUBLEZERO_METRICS_FILE="${METRICS_DIR}/hyperspace_doublezero.prom"
DOUBLEZERO_METRICS_URL="${HYPERSPACE_DOUBLEZERO_METRICS_URL:-http://127.0.0.1:2112/metrics}"
TIER_FILE="${HYPERSPACE_GATE_TIER_FILE:-/etc/hyperspace/gate-tier}"
PROC_ROOT="${HYPERSPACE_GATE_PROC_ROOT:-/proc}"
SYS_ROOT="${HYPERSPACE_GATE_SYS_ROOT:-/sys}"

metric_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  printf '%s' "$value"
}

read_number() {
  local path="$1"
  if [[ -r "$path" ]]; then
    tr -cd '0-9' <"$path"
  else
    printf '0'
  fi
}

default_interface() {
  ip -4 route show default 2>/dev/null | awk 'NR == 1 {for (i = 1; i <= NF; i++) if ($i == "dev") {print $(i + 1); exit}}'
}

interface_counter() {
  local interface="$1"
  local counter="$2"
  read_number "${SYS_ROOT}/class/net/${interface}/statistics/${counter}"
}

udp_counter() {
  local name="$1"
  awk -v wanted="$name" '
    $1 == "Udp:" && !header { for (i = 2; i <= NF; i++) key[i] = $i; header = 1; next }
    $1 == "Udp:" && header { for (i = 2; i <= NF; i++) if (key[i] == wanted) { print $i; exit } }
  ' "${PROC_ROOT}/net/snmp" 2>/dev/null || printf '0'
}

softnet_counter() {
  local column="$1"
  local value total=0
  while read -r -a fields; do
    value="${fields[$((column - 1))]:-0}"
    total="$((total + 16#${value}))"
  done <"${PROC_ROOT}/net/softnet_stat" 2>/dev/null || true
  printf '%s' "$total"
}

vnstat_total() {
  local interface="$1"
  local direction="$2"
  if ! command -v vnstat >/dev/null 2>&1; then
    printf '0'
    return
  fi
  vnstat --json 1 -i "$interface" 2>/dev/null \
    | jq -r --arg direction "$direction" '.interfaces[0].traffic.total[$direction] // 0' 2>/dev/null \
    || printf '0'
}

vnstat_database_mtime() {
  local database
  for database in /var/lib/vnstat/vnstat.db /var/lib/vnstat/*; do
    if [[ -e "$database" ]]; then
      stat -c %Y "$database" 2>/dev/null || true
      return
    fi
  done
  printf '0'
}

recent_conntrack_full_events() {
  if ! command -v journalctl >/dev/null 2>&1; then
    printf '0'
    return
  fi
  journalctl -k --since '-2 minutes' --no-pager 2>/dev/null \
    | grep -c 'nf_conntrack: table full' || true
}

write_doublezero_metrics() {
  local now="$1"
  local success=0
  local raw_file="${DOUBLEZERO_METRICS_FILE}.raw"
  if curl -fsS --max-time 3 "$DOUBLEZERO_METRICS_URL" >"$raw_file" 2>/dev/null; then
    success=1
  else
    : >"$raw_file"
  fi
  {
    awk '/^# (HELP|TYPE) doublezero_/ || /^doublezero_/' "$raw_file"
    printf '# HELP hyperspace_gate_doublezero_metrics_last_scrape_success Whether the local aggregate DoubleZero metrics scrape succeeded.\n'
    printf '# TYPE hyperspace_gate_doublezero_metrics_last_scrape_success gauge\n'
    printf 'hyperspace_gate_doublezero_metrics_last_scrape_success %s\n' "$success"
    printf '# HELP hyperspace_gate_doublezero_metrics_last_scrape_timestamp_seconds Unix timestamp of the local aggregate DoubleZero metrics scrape.\n'
    printf '# TYPE hyperspace_gate_doublezero_metrics_last_scrape_timestamp_seconds gauge\n'
    printf 'hyperspace_gate_doublezero_metrics_last_scrape_timestamp_seconds %s\n' "$now"
  } >"${DOUBLEZERO_METRICS_FILE}.tmp"
  mv "${DOUBLEZERO_METRICS_FILE}.tmp" "$DOUBLEZERO_METRICS_FILE"
  rm -f "$raw_file"
}

main() {
  local now tier physical physical_label overlay_present overlay_rx overlay_tx
  local conntrack_entries conntrack_max conntrack_acct
  local vnstat_running vnstat_mtime vnstat_rx vnstat_tx

  now="$(date +%s)"
  tier="standard"
  [[ -r "$TIER_FILE" ]] && tier="$(tr -d '[:space:]' <"$TIER_FILE")"
  physical="$(default_interface)"
  physical_label="$(metric_escape "${physical:-unknown}")"
  overlay_present=0
  overlay_rx=0
  overlay_tx=0
  if [[ -d "${SYS_ROOT}/class/net/doublezero0" ]]; then
    overlay_present=1
    overlay_rx="$(interface_counter doublezero0 rx_bytes)"
    overlay_tx="$(interface_counter doublezero0 tx_bytes)"
  fi

  conntrack_entries="$(read_number "${PROC_ROOT}/sys/net/netfilter/nf_conntrack_count")"
  conntrack_max="$(read_number "${PROC_ROOT}/sys/net/netfilter/nf_conntrack_max")"
  conntrack_acct="$(read_number "${PROC_ROOT}/sys/net/netfilter/nf_conntrack_acct")"
  vnstat_running=0
  systemctl is-active --quiet vnstat 2>/dev/null && vnstat_running=1
  vnstat_mtime="$(vnstat_database_mtime)"
  vnstat_rx=0
  vnstat_tx=0
  if [[ -n "$physical" ]]; then
    vnstat_rx="$(vnstat_total "$physical" rx)"
    vnstat_tx="$(vnstat_total "$physical" tx)"
  fi

  install -d -m 0755 "$METRICS_DIR"
  {
    printf '# HELP hyperspace_gate_resource_exporter_last_run_timestamp_seconds Unix timestamp of the last resource exporter run.\n'
    printf '# TYPE hyperspace_gate_resource_exporter_last_run_timestamp_seconds gauge\n'
    printf 'hyperspace_gate_resource_exporter_last_run_timestamp_seconds %s\n' "$now"
    printf '# HELP hyperspace_gate_resource_tier Gate resource tier. Exactly one labelled sample has value 1.\n'
    printf '# TYPE hyperspace_gate_resource_tier gauge\n'
    printf 'hyperspace_gate_resource_tier{tier="%s"} 1\n' "$(metric_escape "$tier")"
    printf '# HELP hyperspace_gate_physical_interface Gate physical interface selected from the IPv4 default route.\n'
    printf '# TYPE hyperspace_gate_physical_interface gauge\n'
    printf 'hyperspace_gate_physical_interface{interface="%s"} %s\n' "$physical_label" "$([[ -n "$physical" ]] && printf 1 || printf 0)"
    printf '# HELP hyperspace_gate_physical_receive_bytes_total Physical interface receive bytes for provider reconciliation.\n'
    printf '# TYPE hyperspace_gate_physical_receive_bytes_total counter\n'
    printf 'hyperspace_gate_physical_receive_bytes_total{interface="%s"} %s\n' "$physical_label" "$(interface_counter "$physical" rx_bytes)"
    printf '# HELP hyperspace_gate_physical_transmit_bytes_total Physical interface transmit bytes for provider reconciliation.\n'
    printf '# TYPE hyperspace_gate_physical_transmit_bytes_total counter\n'
    printf 'hyperspace_gate_physical_transmit_bytes_total{interface="%s"} %s\n' "$physical_label" "$(interface_counter "$physical" tx_bytes)"
    printf '# HELP hyperspace_gate_doublezero_interface_present Whether doublezero0 exists.\n'
    printf '# TYPE hyperspace_gate_doublezero_interface_present gauge\n'
    printf 'hyperspace_gate_doublezero_interface_present %s\n' "$overlay_present"
    printf '# HELP hyperspace_gate_doublezero_receive_bytes_total DoubleZero overlay receive bytes; do not add to physical traffic.\n'
    printf '# TYPE hyperspace_gate_doublezero_receive_bytes_total counter\n'
    printf 'hyperspace_gate_doublezero_receive_bytes_total %s\n' "$overlay_rx"
    printf '# HELP hyperspace_gate_doublezero_transmit_bytes_total DoubleZero overlay transmit bytes; do not add to physical traffic.\n'
    printf '# TYPE hyperspace_gate_doublezero_transmit_bytes_total counter\n'
    printf 'hyperspace_gate_doublezero_transmit_bytes_total %s\n' "$overlay_tx"
    printf '# HELP hyperspace_gate_conntrack_entries Current conntrack entry count.\n'
    printf '# TYPE hyperspace_gate_conntrack_entries gauge\n'
    printf 'hyperspace_gate_conntrack_entries %s\n' "$conntrack_entries"
    printf '# HELP hyperspace_gate_conntrack_limit Configured conntrack entry limit.\n'
    printf '# TYPE hyperspace_gate_conntrack_limit gauge\n'
    printf 'hyperspace_gate_conntrack_limit %s\n' "$conntrack_max"
    printf '# HELP hyperspace_gate_conntrack_accounting_enabled Whether per-flow conntrack accounting is enabled.\n'
    printf '# TYPE hyperspace_gate_conntrack_accounting_enabled gauge\n'
    printf 'hyperspace_gate_conntrack_accounting_enabled %s\n' "$conntrack_acct"
    printf '# HELP hyperspace_gate_conntrack_table_full_events_recent Kernel conntrack table-full messages during the last two minutes.\n'
    printf '# TYPE hyperspace_gate_conntrack_table_full_events_recent gauge\n'
    printf 'hyperspace_gate_conntrack_table_full_events_recent %s\n' "$(recent_conntrack_full_events)"
    printf '# HELP hyperspace_gate_udp_receive_buffer_errors_total UDP receive buffer errors reported by the kernel.\n'
    printf '# TYPE hyperspace_gate_udp_receive_buffer_errors_total counter\n'
    printf 'hyperspace_gate_udp_receive_buffer_errors_total %s\n' "$(udp_counter RcvbufErrors)"
    printf '# HELP hyperspace_gate_udp_send_buffer_errors_total UDP send buffer errors reported by the kernel.\n'
    printf '# TYPE hyperspace_gate_udp_send_buffer_errors_total counter\n'
    printf 'hyperspace_gate_udp_send_buffer_errors_total %s\n' "$(udp_counter SndbufErrors)"
    printf '# HELP hyperspace_gate_softnet_dropped_total Packets dropped in the kernel softnet backlog.\n'
    printf '# TYPE hyperspace_gate_softnet_dropped_total counter\n'
    printf 'hyperspace_gate_softnet_dropped_total %s\n' "$(softnet_counter 2)"
    printf '# HELP hyperspace_gate_softnet_time_squeezed_total Softnet processing cycles that exhausted their budget.\n'
    printf '# TYPE hyperspace_gate_softnet_time_squeezed_total counter\n'
    printf 'hyperspace_gate_softnet_time_squeezed_total %s\n' "$(softnet_counter 3)"
    printf '# HELP hyperspace_gate_vnstat_service_up Whether vnstatd is active.\n'
    printf '# TYPE hyperspace_gate_vnstat_service_up gauge\n'
    printf 'hyperspace_gate_vnstat_service_up %s\n' "$vnstat_running"
    printf '# HELP hyperspace_gate_vnstat_database_mtime_seconds Unix modification time of the vnstat database.\n'
    printf '# TYPE hyperspace_gate_vnstat_database_mtime_seconds gauge\n'
    printf 'hyperspace_gate_vnstat_database_mtime_seconds %s\n' "$vnstat_mtime"
    printf '# HELP hyperspace_gate_vnstat_physical_receive_bytes_total Persistent vnstat receive total for the physical interface.\n'
    printf '# TYPE hyperspace_gate_vnstat_physical_receive_bytes_total counter\n'
    printf 'hyperspace_gate_vnstat_physical_receive_bytes_total{interface="%s"} %s\n' "$physical_label" "$vnstat_rx"
    printf '# HELP hyperspace_gate_vnstat_physical_transmit_bytes_total Persistent vnstat transmit total for the physical interface.\n'
    printf '# TYPE hyperspace_gate_vnstat_physical_transmit_bytes_total counter\n'
    printf 'hyperspace_gate_vnstat_physical_transmit_bytes_total{interface="%s"} %s\n' "$physical_label" "$vnstat_tx"
  } >"${METRICS_FILE}.tmp"
  mv "${METRICS_FILE}.tmp" "$METRICS_FILE"
  write_doublezero_metrics "$now"
}

main "$@"
