# Observability

This bundle keeps the three observability ontologies separate:

- Health is served by each runtime component as current component state.
- Metrics are raw runtime events queued in-process and aggregated into
  Prometheus exposition by a dedicated metrics sink.
- Alerting is expressed as Prometheus rules and visualized in Grafana.
- Notification delivery is handled by Alertmanager. Telegram recipients are
  configured in `/etc/prometheus/alertmanager_telegram_receivers.json`; each
  chat, channel, or private user `chat_id` declares the severities it receives.
- Alert delivery itself is supervised by `hyperspace-meta-watch`, which sends
  directly through a separate Telegram bot and Resend instead of Alertmanager.

Runtime endpoints:

- control-plane API: `GET /health`, `GET /metrics`
- control-plane worker: `GET /health`, `GET /metrics` on
  `WORKER_OBSERVABILITY_HOST:WORKER_OBSERVABILITY_PORT`

Deployment artifacts:

- `prometheus/prometheus.testnet.yml`
- `prometheus/prometheus.staging.yml`
- `prometheus/prometheus.mainnet.yml`
- `blackbox/blackbox.yml`
- `prometheus/rules/hyperspace-alerts.yml`
- `alertmanager/alertmanager.yml.template`
- `alertmanager/telegram-receivers.example.json`
- `alertmanager/telegram-receivers.staging.example.json`
- `alertmanager/templates/telegram.tmpl`
- `grafana/provisioning/datasources/prometheus.yml`
- `grafana/provisioning/dashboards/hyperspace.yml`
- `grafana/dashboards/hyperspace-control-plane.json`
- `caddy/Caddyfile`
- `systemd/hyperspace-meta-watch.service`
- `systemd/hyperspace-meta-watch.timer`
- `systemd/hyperspace-meta-watch.env.example`

The dashboard covers service scrape health, schedulable gates, sessions, jobs,
API request rate and p95 latency, worker loop duration, benchmark RTT, packet
loss, and benchmark staleness. The alert rules cover API/worker scrape failure,
too few schedulable gates, per-gate agent disconnects, per-gate readiness and
DoubleZero readiness failures while the agent is connected, dead jobs, benchmark
failures, stale benchmark data, API 5xx rate, and public API rate-limit
activity. Benchmark failure and staleness alerts are emitted per directed route
and transport so notifications include the affected source gate, target gate,
and Internet/DoubleZero path.
Web, control-plane, PostgreSQL, and observability hosts are scraped through the
cluster-local `hyperspace-host-node` job. Every static target carries `role`,
`service_host`, and `service_ipv4`, so host, PostgreSQL, and blackbox alerts
render the concrete machine's `Service access` block. PostgreSQL operational
metrics combine the standard postgres exporter with a local node-exporter
textfile collector for connection pressure, long transactions, autovacuum,
database growth, WAL size, and backup age.
`HyperspaceGateNetworkDrops` excludes per-assignment `hsc*`, `hste*`, and
`hsti*` interfaces: their policy and teardown counters are expected dataplane
activity. Physical NIC and shared DoubleZero-interface drops remain alertable.

`HyperspaceGateDoubleZeroSessionMissing` is critical after five minutes with a
fresh agent, unavailable DoubleZero, no current device and manual recovery
required. It carries the gate access labels and explicitly requests operator
intervention; no automatic reconnect is performed for this condition. The
general DoubleZero-not-ready alert excludes it to avoid duplicate pages. See
[the operator runbook](../../docs/runbooks/doublezero-session-missing.md),
including the confirmed administrative user deletions on 2026-09-23.

Validate the dedicated alert and the existing resource rules before deployment:

```bash
promtool check rules infra/observability/prometheus/rules/hyperspace-alerts.yml
promtool test rules infra/observability/prometheus/tests/hyperspace-doublezero-session.test.yml infra/observability/prometheus/tests/hyperspace-gate-resources.test.yml
```

The worker `/metrics` endpoint remains HTTP 200 while a business snapshot is
incomplete. `hyperspace_control_plane_snapshot_ready` reports aggregate
readiness, while `hyperspace_control_plane_snapshot_section_ready{section=...}`
isolates failures without suppressing healthy sections. Prometheus emits
`HyperspaceControlPlaneSnapshotSectionFailed` for a section that remains broken
for one minute; `HyperspaceControlPlaneWorkerDown` is reserved for an actual
scrape, process, or network failure.

Each Prometheus instance checks only services in its own cluster. The separate
meta-monitor forms a one-way readiness ring solely for detecting a complete
observability outage: production watches staging, staging watches testnet, and
testnet watches production. The meta-monitor also validates local Alertmanager,
the cluster's primary Telegram bot and every configured receiver. It pages the
operator through `HyperspaceMetaWatcher_bot` and emails the operator through
Resend after two failed runs; resolution also requires two successful runs.
These direct channels do not depend on Prometheus or Alertmanager.
Managed gate-agent rollouts export their latest phase, immutable release
revision/SHA, age, deadline, and explicit gate access labels. An active rollout
older than ten minutes is critical. Latest failures are classified into
installation, post-install host validation, and other failures. A requested or
completed rollback has its own critical alert. Terminal failure and rollback
alerts remain visible until a later deployment supersedes them.
Dead jobs are intentionally noisy until an operator reviews them. After review,
keep the historical job row and move it from `dead` to `acknowledged_dead`:

```bash
scripts/acknowledge-dead-jobs.mjs --env-file /etc/hyperspace/control-plane-worker.env --older-than "24 hours"
scripts/acknowledge-dead-jobs.mjs --env-file /etc/hyperspace/control-plane-worker.env --older-than "24 hours" --execute --reason "reviewed old setup failures"
```

Only `phase="dead"` triggers `HyperspaceDeadJobsPresent`; acknowledged dead jobs
remain visible in job metrics and admin job listings but do not page the
operator again.

Operational `hyperspace_control_plane_jobs_total` excludes `succeeded` since
2026-09-08: scanning millions of successful historical jobs on every worker
snapshot cycle overloaded the database. All other phases (including `dead` and
`acknowledged_dead`) remain exact, with zero-valued enum combinations retained.
No job history is deleted; historical successful jobs remain in admin listings
and PostgreSQL. There is no fabricated zero or approximate replacement series.
Worker snapshots use a separate one-connection pool with a 2-second SQL limit;
failed collectors retain their previous gauges and expose degraded health.
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

### Retired gates and probe alerts

Gate alerts use `gate` labels, but `HyperspaceTradingProbeNodeStale` uses `node`.
After retiring a gate, verify both labels in Prometheus and Alertmanager. Disable
the gate and linked probe nodes in the authoritative catalog, revoke their
credentials, and remove retired entries from deployment seeds and file discovery.
Revoke related VPN sessions and wait for cleanup acknowledgements from surviving
peers before releasing client addresses and hiding configs. Offline assignments
may be closed administratively with an audit record; never claim a host cleanup
report that was not received. Preserve payment and usage history.
Include hidden failed creates in the audit: normal revocation deliberately skips
hidden sessions. Normalize their lifecycle administratively only after proving
they have no host assignments or available artifacts; do not unhide them.

The probes worker replaces dynamic node/target gauge families after each
successful read. Removed nodes and changed labels must disappear without a
restart; a failed read retains the preceding snapshot and exposes the collector
failure. Restart only the optional probes worker when deploying this collector
fix; core API, core worker and gates do not need a restart. Verify retired alerts
are absent, not silenced. An existing Telegram group may send one final RESOLVED
notification because `send_resolved` is enabled.
# Уведомления после исправления 23.10.2026

Production `alertmanager_telegram_receivers.json` направляет `critical` только
в `hyperspace-telegram-critical`, а `warning`/`info` — в основной чат. Используйте
`scripts/render-alertmanager-telegram-config` вместе с
`infra/observability/alertmanager/noise-policy.yml`; оба файла входят в deployment.
Renderer сохраняет первое уведомление и `send_resolved`, но задаёт repeat 12h
только для archive failed/stale и Helius usage failed/stale. Обычный repeat 4h
для API/gate outages не меняется.

Inhibition ограничен подтверждёнными зависимостями:

- `ArchiveFailed` подавляет `ArchiveStale` только того же cluster/service_host.
- `HeliusUsageDataStale` подавляет `HeliusUsagePollFailed` того же cluster/instance.
- `MeasurementsMongoUnavailable` подавляет stale trading targets, benchmark
  routes и public measurement snapshots только того же cluster.

После устранения причины оставшийся зависимый алерт снова виден. Правила не
подавляют потерю gate heartbeat, API down, проблемы другого host/cluster или
quota-exhausted. Alertmanager reload сохраняет состояние уведомлений;
Prometheus и VPN gates перезапускать не требуется.

Проверка: `node --test scripts/observability/alertmanager-noise.test.mjs`.
Тест поднимает изолированный Alertmanager **без внешних получателей**, проверяет
маршрутизацию, inhibition, отсутствие подавления API/gate outages и снятие
inhibition после восстановления источника. Не отправляйте тестовые инциденты
в production для проверки маршрутов: используйте `amtool config routes test`.

Helius usage polling ограничен 15 секундами, ошибки содержат HTTP status,
категорию и безопасный request ID без response body/URL/key. Метрики:
`helius_usage_last_http_status`, `helius_usage_consecutive_failures` и
`helius_usage_poll_errors_total{reason=...}`. При 401/403 проверить соответствие
project/key, права Admin API и provider access policy. Последние достоверные
credits сохраняются, freshness продолжает сигнализировать о сбое опроса.
