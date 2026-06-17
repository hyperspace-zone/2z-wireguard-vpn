# Milestone 2 Observability Validation

Date: 2026-06-17
Branch: `milestone2-benchmarking-monitoring`

## Live endpoints

- Testnet Grafana: https://observability.testnet.hyperspace.zone/d/hyperspace-control-plane/hyperspace-control-plane
- Testnet Prometheus alerts: https://observability.testnet.hyperspace.zone/prometheus/alerts
- Mainnet Grafana: https://observability.hyperspace.zone/d/hyperspace-control-plane/hyperspace-control-plane
- Mainnet Prometheus alerts: https://observability.hyperspace.zone/prometheus/alerts

## Verified checks

- Grafana health returns `database: ok` on testnet and mainnet.
- Grafana dashboard `Hyperspace Control Plane` is provisioned with 12 panels on testnet and mainnet.
- Prometheus targets are `up` for the control-plane API and worker on testnet and mainnet.
- Grafana datasource query for `up` returns two Prometheus series on testnet and mainnet.
- Prometheus alert rules load successfully on testnet and mainnet.
- API and worker health endpoints report component states separately from Prometheus metrics.

## Alert state at validation time

- Testnet: API down and worker down alerts were inactive; dead jobs was firing and benchmark failures was pending because the testnet database contained real failed jobs/routes.
- Mainnet: all configured alert rules were inactive.

## Screenshots

- `testnet-grafana-dashboard.png`
- `mainnet-grafana-dashboard.png`
