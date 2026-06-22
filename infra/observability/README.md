# Observability

This bundle keeps the three observability ontologies separate:

- Health is served by each runtime component as current component state.
- Metrics are raw runtime events queued in-process and aggregated into
  Prometheus exposition by a dedicated metrics sink.
- Alerting is expressed as Prometheus rules and visualized in Grafana.
- Notification delivery is handled by Alertmanager. The production deployment
  uses a Telegram receiver for the team chat.

Runtime endpoints:

- control-plane API: `GET /health`, `GET /metrics`
- control-plane worker: `GET /health`, `GET /metrics` on
  `WORKER_OBSERVABILITY_HOST:WORKER_OBSERVABILITY_PORT`

Deployment artifacts:

- `prometheus/prometheus.testnet.yml`
- `prometheus/prometheus.mainnet.yml`
- `prometheus/rules/hyperspace-alerts.yml`
- `alertmanager/alertmanager.yml.template`
- `alertmanager/templates/telegram.tmpl`
- `grafana/provisioning/datasources/prometheus.yml`
- `grafana/provisioning/dashboards/hyperspace.yml`
- `grafana/dashboards/hyperspace-control-plane.json`
- `caddy/Caddyfile`

The dashboard covers service scrape health, schedulable gates, sessions, jobs,
API request rate and p95 latency, worker loop duration, benchmark RTT, packet
loss, and benchmark staleness. The alert rules cover API/worker scrape failure,
too few schedulable gates, per-gate stale heartbeats, per-gate readiness and
DoubleZero readiness failures, dead jobs, benchmark failures, stale benchmark
data, API 5xx rate, and public API rate-limit activity. Benchmark failure and
staleness alerts are emitted per directed route and transport so notifications
include the affected source gate, target gate, and Internet/DoubleZero path.
