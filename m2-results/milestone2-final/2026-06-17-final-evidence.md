# Milestone 2 Final Evidence

Date: 2026-06-17
Branch: `milestone2-benchmarking-monitoring`

## Screenshots

- `testnet-benchmarks.png`
- `mainnet-benchmarks.png`
- `testnet-observability-dashboard.png`
- `mainnet-observability-dashboard.png`

## Live checks

- Testnet benchmark page showed 20 directed routes, 20 Internet transports, and 18 DoubleZero transports.
- Mainnet benchmark page showed 20 directed routes, 20 Internet transports, and 20 DoubleZero transports.
- Testnet Grafana dashboard loaded with control-plane scrape health, schedulable gates, benchmark RTT, and benchmark loss panels.
- Mainnet Grafana dashboard loaded with control-plane scrape health, schedulable gates, benchmark RTT, benchmark loss, gate health, sessions, API requests, and API latency panels.

## Observability host stability

Grafana on the testnet observability host previously hit API/dashboard handler
timeouts on a 1 GB VM without swap.

- Testnet observability host: `observability.testnet.hyperspace.zone`, IP `81.27.101.158`.
- Mainnet observability host: `observability.hyperspace.zone`, IP `84.32.83.71`.
- Added a persistent 2 GB `/swapfile` on both observability hosts.
- Added `/etc/sysctl.d/99-hyperspace-observability.conf` with `vm.swappiness=10` and `vm.vfs_cache_pressure=50`.
- Restarted `grafana-server` on both hosts after enabling swap.
- Verified Grafana health, dashboard provisioning, Prometheus `up`, and Grafana datasource query on both hosts.

Long-term recommendation: resize observability hosts to at least 2 GB RAM;
keep swap as a safety net rather than the primary fix.
