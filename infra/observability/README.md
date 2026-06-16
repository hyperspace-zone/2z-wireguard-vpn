# Observability

This directory contains the baseline monitoring and alerting profile for
Hyperspace deployments.

Included:

- Prometheus scrape configuration with file-based target discovery.
- Prometheus alert rules.
- blackbox_exporter HTTP/TCP probe modules.
- postgres_exporter custom SQL queries for Hyperspace control-plane state.
- Grafana datasource and dashboard provisioning.
- Grafana alerting provisioning with a Telegram contact point.
- A baseline Grafana dashboard for API health, gate probes, host health,
  session phases, job phases, gate conditions, and host resource usage.

Start with the runbook:

```text
docs/runbooks/telemetry-grafana-alerting.md
```

The profile is intentionally exporter-first. It works before API, worker, or
gate-agent native `/metrics` endpoints exist. When native metrics are added,
add those targets to:

```text
prometheus/file_sd/hyperspace-native.yml
```
