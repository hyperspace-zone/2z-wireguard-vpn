#!/usr/bin/env bash
set -euo pipefail

config_file="${HYPERSPACE_GATE_FIREWALL_CONFIG:-/etc/hyperspace/gate-firewall.env}"
ufw_bin="${HYPERSPACE_UFW_BIN:-ufw}"
check_only=false
if [[ "${1:-}" == "--check" ]]; then
  check_only=true
elif [[ $# -gt 0 ]]; then
  echo "usage: hyperspace-gate-firewall [--check]" >&2
  exit 2
fi

[[ -r "$config_file" ]] || { echo "missing firewall config: $config_file" >&2; exit 1; }
command -v "$ufw_bin" >/dev/null 2>&1 || { echo "ufw command is unavailable" >&2; exit 1; }

# shellcheck disable=SC1090
source "$config_file"
node_exporter_port="${NODE_EXPORTER_PORT:-9100}"
benchmark_probe_port="${BENCHMARK_PROBE_PORT:-19192}"

valid_ipv4() {
  local address="$1"
  local -a octets=()
  local octet
  IFS=. read -r -a octets <<<"$address"
  [[ ${#octets[@]} -eq 4 ]] || return 1
  for octet in "${octets[@]}"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] || return 1
    ((10#$octet <= 255)) || return 1
  done
}

valid_port() {
  [[ "$1" =~ ^[0-9]{1,5}$ ]] && ((10#$1 > 0 && 10#$1 <= 65535))
}

rule_present() {
  local source="$1"
  local port="$2"
  local protocol="$3"
  "$ufw_bin" show added 2>/dev/null | awk -v source="$source" -v port="$port" -v protocol="$protocol" '
    index($0, "from " source) > 0 && index($0, "port " port) > 0 && index($0, "proto " protocol) > 0 { found = 1 }
    END { exit !found }
  '
}

apply_or_check_rule() {
  local source="$1"
  local port="$2"
  local protocol="$3"
  local comment="$4"
  valid_ipv4 "$source" || { echo "invalid firewall source IPv4: $source" >&2; exit 1; }
  if [[ "$check_only" == true ]]; then
    rule_present "$source" "$port" "$protocol" || {
      echo "missing persistent UFW rule: $source $protocol/$port" >&2
      exit 1
    }
    return
  fi
  "$ufw_bin" allow from "$source" to any port "$port" proto "$protocol" comment "$comment" >/dev/null
}

valid_port "$node_exporter_port" || { echo "invalid NODE_EXPORTER_PORT" >&2; exit 1; }
valid_port "$benchmark_probe_port" || { echo "invalid BENCHMARK_PROBE_PORT" >&2; exit 1; }
[[ -n "${OBSERVABILITY_IPS:-}" ]] || { echo "OBSERVABILITY_IPS is empty" >&2; exit 1; }
[[ -n "${BENCHMARK_PEER_IPS:-}" ]] || { echo "BENCHMARK_PEER_IPS is empty" >&2; exit 1; }

for source in $OBSERVABILITY_IPS; do
  apply_or_check_rule "$source" "$node_exporter_port" tcp hyperspace-observability
done
for source in $BENCHMARK_PEER_IPS; do
  apply_or_check_rule "$source" "$benchmark_probe_port" udp hyperspace-benchmark
done

if [[ "$check_only" == false ]] && "$ufw_bin" status 2>/dev/null | grep -q '^Status: active'; then
  "$ufw_bin" reload >/dev/null
fi
