# Observability

Recommended target:

- host: dedicated observability host or private monitoring stack
- metrics: Prometheus
- dashboards: Grafana
- node metrics: node_exporter on every host
- database metrics: postgres_exporter on the database host

The API, worker, and gate agent expose structured logs and metrics. Required
dashboards cover gate health, provisioning latency, revocation latency, drift,
retry rate, dead jobs, active sessions, and artifact issuance.
