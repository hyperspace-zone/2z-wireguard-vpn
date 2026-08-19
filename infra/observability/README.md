# Observability

This bundle keeps the three observability ontologies separate:

- Health is served by each runtime component as current component state.
- Metrics are raw runtime events queued in-process and aggregated into
  Prometheus exposition by a dedicated metrics sink.
- Alerting is expressed as Prometheus rules and visualized in Grafana.
- Notification delivery is handled by Alertmanager. Telegram recipients are
  configured in `/etc/prometheus/alertmanager_telegram_receivers.json`; each
  chat, channel, or private user `chat_id` declares the severities it receives.

Runtime endpoints:

- control-plane API: `GET /health`, `GET /metrics`
- control-plane worker: `GET /health`, `GET /metrics` on
  `WORKER_OBSERVABILITY_HOST:WORKER_OBSERVABILITY_PORT`

Deployment artifacts:

- `prometheus/prometheus.testnet.yml`
- `prometheus/prometheus.mainnet.yml`
- `prometheus/rules/hyperspace-alerts.yml`
- `alertmanager/alertmanager.yml.template`
- `alertmanager/telegram-receivers.example.json`
- `alertmanager/templates/telegram.tmpl`
- `grafana/provisioning/datasources/prometheus.yml`
- `grafana/provisioning/dashboards/hyperspace.yml`
- `grafana/dashboards/hyperspace-control-plane.json`
- `caddy/Caddyfile`

The dashboard covers service scrape health, schedulable gates, sessions, jobs,
API request rate and p95 latency, worker loop duration, benchmark RTT, packet
loss, and benchmark staleness. The alert rules cover API/worker scrape failure,
too few schedulable gates, per-gate agent disconnects, per-gate readiness and
DoubleZero readiness failures while the agent is connected, dead jobs, benchmark
failures, stale benchmark data, API 5xx rate, and public API rate-limit
activity. Benchmark failure and staleness alerts are emitted per directed route
and transport so notifications include the affected source gate, target gate,
and Internet/DoubleZero path.
Managed gate-agent rollouts export their latest phase, immutable release
revision/SHA, age, deadline, and explicit gate access labels. An active rollout
older than ten minutes or a latest `failed` rollout is critical; the latter
remains visible until a later deployment supersedes it.
Dead jobs are intentionally noisy until an operator reviews them. After review,
keep the historical job row and move it from `dead` to `acknowledged_dead`:

```bash
scripts/acknowledge-dead-jobs.mjs --env-file /etc/hyperspace/control-plane-worker.env --older-than "24 hours"
scripts/acknowledge-dead-jobs.mjs --env-file /etc/hyperspace/control-plane-worker.env --older-than "24 hours" --execute --reason "reviewed old setup failures"
```

Only `phase="dead"` triggers `HyperspaceDeadJobsPresent`; acknowledged dead jobs
remain visible in job metrics and admin job listings but do not page the
operator again.
Benchmark route alerts are suppressed when either endpoint gate is disconnected;
that case is covered by the per-gate agent connectivity alert.
Benchmark route notifications render separate copyable `Source gate access`
and `Target gate access` blocks from explicit catalog `probeUrl` and
`publicIpv4` values. They never fall back to the worker's control-plane
`Service access` labels.
Alertmanager groups benchmark route transports together by route to avoid
separate adjacent Telegram messages for Internet and DoubleZero on the same
route.
Per-gate Telegram alerts include a copyable `host` value from the explicit
gate catalog `probeUrl` plus the catalog `publicIpv4`; alert routing must not
derive DNS names from `gate.name`.
Control-plane API and worker scrape targets carry explicit `service_host` and
`service_ipv4` labels. Infrastructure alerts use them to render a copyable
`Service access` block without presenting a control-plane host as a gate.
Render `/etc/prometheus/alertmanager.yml` with
`scripts/render-alertmanager-telegram-config` after editing
`/etc/prometheus/alertmanager_telegram_receivers.json`, then validate it with
`amtool check-config` and restart `prometheus-alertmanager`.

Telegram notifications include the Alertmanager `started UTC` timestamp for
every alert and an additional `resolved UTC` timestamp after recovery. These
timestamps come from the alert payload rather than the Telegram delivery time.
