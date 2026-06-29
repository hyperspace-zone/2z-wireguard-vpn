# Milestone 2 Final Evidence

Date: 2026-06-29
Branch: `milestone2-benchmarking-monitoring`

## Acceptance Summary

Milestone 2 requires a pilot environment, benchmarking, and monitoring:

- testnet and mainnet gates running for the initial footprint,
- benchmark results for DoubleZero vs Internet RTT/jitter/loss,
- dashboard screenshots.

The current live deployment satisfies the functional acceptance criteria.

## Gate Footprint

Testnet has 5 enabled gates:

- `gate-ap-sin-01`
- `gate-eu-ams-01`
- `gate-eu-fra-01`
- `gate-eu-lon-01`
- `gate-na-nyc-01`

Mainnet has 14 enabled gates:

- `gate-ap-hkg-21`
- `gate-ap-sin-21`
- `gate-ap-tyo-21`
- `gate-eu-ams-21`
- `gate-eu-fra-21`
- `gate-eu-lon-01`
- `gate-eu-mad-01`
- `gate-eu-osl-01`
- `gate-eu-sia-21`
- `gate-eu-sto-21`
- `gate-na-chi-21`
- `gate-na-sjc-01`
- `gate-na-slc-21`
- `gate-sa-sao-21`

The grant text calls for 8-12 mainnet PoPs in the initial footprint. The
deployment now intentionally runs a larger 14-gate footprint because Hong Kong,
Salt Lake City, and Sao Paulo were added after access-pass approval, while the
older disabled Chicago gate was removed from scheduling. This is an expansion of
the initial footprint rather than a reduction in scope.

## Live Checks

Captured on 2026-06-29:

- Testnet gates: all 5 enabled gates report fresh heartbeats, `BGP Session Up`,
  and matching DoubleZero current/lowest-latency devices.
- Mainnet gates: all 14 enabled gates report fresh heartbeats, `BGP Session Up`,
  and matching DoubleZero current/lowest-latency devices.
- Testnet latest benchmark samples: 40/40 succeeded, 0 failed, 0 stale.
- Mainnet latest benchmark samples: 364/364 succeeded, 0 failed, 0 stale.
- Testnet control-plane metrics: 0 failed routes, 0 stale routes, 0 unhealthy
  enabled gate metrics, 0 unschedulable enabled gate metrics.
- Mainnet control-plane metrics: 0 failed routes, 0 stale routes, 0 unhealthy
  enabled gate metrics, 0 unschedulable enabled gate metrics.
- Testnet Prometheus: no active Hyperspace alerts.
- Mainnet Prometheus: no active Hyperspace alerts.

## Benchmark Coverage

The Benchmarks page and public API expose directed gate-to-gate comparison rows
for:

- Internet RTT, RTT jitter, loss,
- DoubleZero RTT, RTT jitter, loss,
- RTT improvement and time saved,
- one-way measurements and clock-error context,
- gate-to-DoubleZero overhead columns.

The mainnet screenshot now reflects the 14-gate footprint, which produces 182
directed gate pairs and 364 latest transport samples across Internet and
DoubleZero.

## Monitoring And Alerting

Grafana and Prometheus are deployed for both clusters:

- Testnet Grafana: `https://observability.testnet.hyperspace.zone/d/hyperspace-control-plane/hyperspace-control-plane`
- Mainnet Grafana: `https://observability.hyperspace.zone/d/hyperspace-control-plane/hyperspace-control-plane`

The dashboard includes:

- control-plane scrape health,
- schedulable gates,
- gate health states,
- VPN sessions,
- API requests and latency,
- control-plane jobs,
- worker loop duration,
- benchmark RTT by transport,
- benchmark loss by transport.

Alerting is configured through Prometheus Alertmanager with Telegram routing for
critical and warning/info severities. Alert rules are provisioned from
`infra/observability/prometheus/rules/hyperspace-alerts.yml`.

## Hardening And Abuse Controls

Basic abuse controls are implemented and documented:

- public API read/mutation/download rate limits,
- active self-service session quota per account,
- session create burst quota,
- IP-to-IP destination guardrails requiring public IPv4 `/32` destinations by
  default,
- source CIDR validation while allowing unrestricted full-tunnel source access,
- audit records for rejected self-service session creation.

Validation commands run on 2026-06-29:

- `npm run test -w @hyperspace-zone/control-plane`
- `npm run test -w @hyperspace-zone/control-plane-api`
- `promtool check rules /etc/prometheus/rules/hyperspace-alerts.yml`

## Screenshots

Updated on 2026-06-29:

- `testnet-benchmarks.png`
- `mainnet-benchmarks.png`
- `testnet-observability-dashboard.png`
- `mainnet-observability-dashboard.png`

## Observability Host Stability

Grafana on the testnet observability host previously hit API/dashboard handler
timeouts on a 1 GB VM without swap.

- Testnet observability host: `observability.testnet.hyperspace.zone`, IP
  `81.27.101.158`.
- Mainnet observability host: `observability.hyperspace.zone`, IP
  `84.32.83.71`.
- Added a persistent 2 GB `/swapfile` on both observability hosts.
- Added `/etc/sysctl.d/99-hyperspace-observability.conf` with
  `vm.swappiness=10` and `vm.vfs_cache_pressure=50`.
- Restarted `grafana-server` on both hosts after enabling swap.
- Verified Grafana health, dashboard provisioning, Prometheus `up`, and Grafana
  datasource query on both hosts.

Long-term recommendation: resize observability hosts to at least 2 GB RAM; keep
swap as a safety net rather than the primary fix.
