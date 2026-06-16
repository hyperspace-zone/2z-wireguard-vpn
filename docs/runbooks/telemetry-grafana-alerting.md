# Telemetry, Grafana, And Telegram Alerting

This runbook installs a baseline observability stack for a Hyperspace
deployment:

- Prometheus for metrics collection and alert rule evaluation.
- Grafana for dashboards and Grafana-managed alerting.
- node_exporter on every host.
- postgres_exporter on the PostgreSQL host.
- blackbox_exporter on the observability host for HTTP/TCP checks.
- Telegram as the first notification channel.

The repository ships a ready profile under `infra/observability`. It is
designed for the current bare-metal/systemd deployment model and can run on a
dedicated observability host or on the control-plane host for small testnet
deployments.

References:

- Grafana provisioning:
  https://grafana.com/docs/grafana/latest/administration/provisioning/
- Grafana alerting file provisioning:
  https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/file-provisioning/
- Grafana Telegram contact point:
  https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/configure-telegram/
- Prometheus configuration and file service discovery:
  https://prometheus.io/docs/prometheus/latest/configuration/configuration/

## Target Layout

Recommended host placement:

| Component | Host | Port | Access |
| --- | --- | --- | --- |
| Prometheus | Observability host | `9090` | Private network only |
| Grafana | Observability host | `3000` | Operators only, HTTPS through Caddy or VPN |
| blackbox_exporter | Observability host | `9115` | Local Prometheus only |
| node_exporter | Every host | `9100` | Prometheus host only |
| postgres_exporter | PostgreSQL host | `9187` | Prometheus host only |

Do not expose Prometheus, node_exporter, postgres_exporter, or blackbox_exporter
to the public internet.

## Files In This Profile

| Path | Purpose |
| --- | --- |
| `infra/observability/prometheus/prometheus.yml` | Prometheus scrape jobs and rule files. |
| `infra/observability/prometheus/blackbox.yml` | HTTP/TCP probe modules. |
| `infra/observability/prometheus/file_sd/*.example` | Editable target inventory examples. |
| `infra/observability/prometheus/rules/hyperspace-alerts.yml` | Prometheus alert rules. |
| `infra/observability/postgres-exporter/hyperspace-queries.yaml` | Control-plane SQL metrics. |
| `infra/observability/grafana/provisioning/datasources/prometheus.yaml` | Grafana Prometheus datasource. |
| `infra/observability/grafana/provisioning/dashboards/hyperspace.yaml` | Grafana dashboard provider. |
| `infra/observability/grafana/provisioning/alerting/hyperspace-telegram-alert-profile.yaml` | Telegram contact point, notification policy, and Grafana-managed alerts. |
| `infra/observability/grafana/dashboards/hyperspace-overview.json` | Baseline dashboard. |

## Prerequisites

- Ubuntu 24.04 LTS or comparable Linux on the observability host.
- Root or sudo access on every monitored host.
- Network reachability from the observability host to:
  - `9100/tcp` on every host.
  - `9187/tcp` on the PostgreSQL host.
  - public HTTPS health/probe endpoints.
- A Telegram bot token and target chat ID.
- A PostgreSQL monitoring user with read access to the Hyperspace database.

## Create The Telegram Connector

Create a bot with BotFather and obtain its token. Add the bot to the target
Telegram chat or channel.

For a private chat, send a message to the bot and then read updates:

```bash
curl -fsS "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates" | jq .
```

For a group or channel, add the bot, send a message, and read the `chat.id`
from the same API response.

Store the values on the Grafana host:

```bash
install -d -m 0750 /etc/grafana
cat >/etc/grafana/grafana-server.env <<'EOF'
GRAFANA_TELEGRAM_BOT_TOKEN=<telegram-bot-token>
GRAFANA_TELEGRAM_CHAT_ID=<telegram-chat-id>
EOF
chmod 0600 /etc/grafana/grafana-server.env
chown root:root /etc/grafana/grafana-server.env
```

The provisioned alert profile reads those environment variables from:

```text
infra/observability/grafana/provisioning/alerting/hyperspace-telegram-alert-profile.yaml
```

## Install Exporters

### node_exporter

Install node_exporter on every control-plane, database, and gate host.

```bash
apt-get update
apt-get install -y prometheus-node-exporter
```

Enable the systemd collector so the baseline service alerts can evaluate
`hyperspace-control-plane-api.service`,
`hyperspace-control-plane-worker.service`, `hyperspace-gate-agent.service`,
`caddy.service`, and `postgresql.service`.

On Ubuntu package installs, add or update:

```bash
install -d -m 0755 /etc/default
cat >/etc/default/prometheus-node-exporter <<'EOF'
ARGS="--collector.systemd --collector.processes"
EOF
systemctl restart prometheus-node-exporter
systemctl enable prometheus-node-exporter
```

Restrict access to the Prometheus host in your firewall or security group.

### postgres_exporter

On the PostgreSQL host, install postgres_exporter:

```bash
apt-get update
apt-get install -y prometheus-postgres-exporter
systemctl list-unit-files | grep -E 'postgres.*exporter'
```

Create a monitoring role:

```bash
sudo -u postgres psql <<'SQL'
CREATE USER hyperspace_monitor WITH PASSWORD '<replace-with-random-password>';
GRANT CONNECT ON DATABASE hyperspace TO hyperspace_monitor;
\c hyperspace
GRANT USAGE ON SCHEMA public TO hyperspace_monitor;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO hyperspace_monitor;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO hyperspace_monitor;
SQL
```

Install the custom query file:

```bash
install -d -m 0755 /etc/postgres-exporter
install -m 0644 infra/observability/postgres-exporter/hyperspace-queries.yaml \
  /etc/postgres-exporter/hyperspace-queries.yaml
```

Configure the exporter environment:

```bash
cat >/etc/default/prometheus-postgres-exporter <<'EOF'
DATA_SOURCE_NAME="postgresql://hyperspace_monitor:<replace-with-password>@127.0.0.1:5432/hyperspace?sslmode=disable"
ARGS="--extend.query-path=/etc/postgres-exporter/hyperspace-queries.yaml"
EOF
chmod 0640 /etc/default/prometheus-postgres-exporter
systemctl restart prometheus-postgres-exporter
systemctl enable prometheus-postgres-exporter
```

Verify:

```bash
curl -fsS http://127.0.0.1:9187/metrics | grep -E 'pg_up|hyperspace_sessions_by_phase_count'
```

## Install Prometheus And blackbox_exporter

On the observability host:

```bash
apt-get update
apt-get install -y prometheus prometheus-blackbox-exporter
```

Install the profile:

```bash
install -d -m 0755 /etc/prometheus/file_sd /etc/prometheus/rules /etc/prometheus/blackbox

install -m 0644 infra/observability/prometheus/prometheus.yml \
  /etc/prometheus/prometheus.yml
install -m 0644 infra/observability/prometheus/blackbox.yml \
  /etc/prometheus/blackbox.yml
install -m 0644 infra/observability/prometheus/rules/hyperspace-alerts.yml \
  /etc/prometheus/rules/hyperspace-alerts.yml

for name in node postgres-exporter http tcp hyperspace-native; do
  install -m 0644 "infra/observability/prometheus/file_sd/${name}.yml.example" \
    "/etc/prometheus/file_sd/${name}.yml"
done
```

Edit the copied files under `/etc/prometheus/file_sd/` and replace all example
hosts with your deployment inventory.

Configure blackbox_exporter to use the shipped module file. On package-based
Ubuntu installs, set:

```bash
cat >/etc/default/prometheus-blackbox-exporter <<'EOF'
ARGS="--config.file=/etc/prometheus/blackbox.yml"
EOF
systemctl restart prometheus-blackbox-exporter
systemctl enable prometheus-blackbox-exporter
```

Validate Prometheus config before restart:

```bash
promtool check config /etc/prometheus/prometheus.yml
promtool check rules /etc/prometheus/rules/hyperspace-alerts.yml
systemctl restart prometheus
systemctl enable prometheus
```

Verify targets:

```bash
curl -fsS http://127.0.0.1:9090/-/ready
curl -fsS 'http://127.0.0.1:9090/api/v1/targets' | jq '.data.activeTargets[] | {job: .labels.job, health, scrapeUrl}'
```

## Install Grafana

Install Grafana OSS using the package method approved for your environment.
After Grafana is installed, verify that the package created the service user
and unit:

```bash
getent passwd grafana
systemctl list-unit-files | grep -E '^grafana-server\.service'
```

Copy the profile:

```bash
install -d -m 0755 \
  /etc/grafana/provisioning/datasources \
  /etc/grafana/provisioning/dashboards \
  /etc/grafana/provisioning/alerting \
  /var/lib/grafana/dashboards/hyperspace

install -m 0644 infra/observability/grafana/provisioning/datasources/prometheus.yaml \
  /etc/grafana/provisioning/datasources/prometheus.yaml
install -m 0644 infra/observability/grafana/provisioning/dashboards/hyperspace.yaml \
  /etc/grafana/provisioning/dashboards/hyperspace.yaml
install -m 0644 infra/observability/grafana/provisioning/alerting/hyperspace-telegram-alert-profile.yaml \
  /etc/grafana/provisioning/alerting/hyperspace-telegram-alert-profile.yaml
install -m 0644 infra/observability/grafana/dashboards/hyperspace-overview.json \
  /var/lib/grafana/dashboards/hyperspace/hyperspace-overview.json

chown -R grafana:grafana /var/lib/grafana/dashboards/hyperspace
```

Make Grafana load the Telegram secret environment file:

```bash
systemctl edit grafana-server
```

Add:

```ini
[Service]
EnvironmentFile=/etc/grafana/grafana-server.env
```

Restart:

```bash
systemctl daemon-reload
systemctl restart grafana-server
systemctl enable grafana-server
```

Verify provisioning:

```bash
journalctl -u grafana-server -n 200 --no-pager | grep -Ei 'provision|alert|dashboard|telegram'
```

Open Grafana and check:

- Datasources: `Prometheus` exists and is healthy.
- Dashboards: folder `Hyperspace` contains `Hyperspace Control Plane Overview`.
- Alerting: contact point `telegram-critical` exists.
- Alerting: notification policy routes to `telegram-critical`.
- Alerting: rule group `hyperspace-core` exists.

## Dashboards

The baseline dashboard intentionally uses only exporter metrics and
postgres_exporter custom queries:

- API health from blackbox HTTP probes.
- Gate probe health from blackbox HTTP probes.
- host availability from node_exporter.
- sessions by phase from PostgreSQL.
- jobs by phase from PostgreSQL.
- gate conditions from PostgreSQL.
- CPU, memory, and disk usage from node_exporter.

When native `/metrics` endpoints are added to the API, worker, or gate-agent,
add their targets to:

```text
/etc/prometheus/file_sd/hyperspace-native.yml
```

Then extend the dashboard with request latency, worker controller duration,
gate-agent job execution duration, and native error counters.

## Ready Alert Profile

The shipped alert profile provisions:

- Telegram contact point: `telegram-critical`.
- Root notification policy that sends all provisioned alerts to Telegram.
- Grafana-managed alerts:
  - `Hyperspace API health down`
  - `Hyperspace host exporter down`
  - `Hyperspace PostgreSQL down`
  - `Hyperspace dead jobs present`
  - `Hyperspace gate agent disconnected`
- Prometheus rule-file alerts under
  `/etc/prometheus/rules/hyperspace-alerts.yml`.

Grafana provisioned resources are file-owned. Edit the YAML in Git and redeploy
instead of editing these resources in the Grafana UI.

## Test Telegram Alerts

First test the bot directly:

```bash
curl -fsS -X POST "https://api.telegram.org/bot${GRAFANA_TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${GRAFANA_TELEGRAM_CHAT_ID}" \
  -d "text=Hyperspace telemetry test"
```

Then test from Grafana:

1. Open Grafana.
2. Go to Alerting.
3. Open Contact points.
4. Select `telegram-critical`.
5. Use Test.

For an end-to-end alert, temporarily add a bad HTTP target to
`/etc/prometheus/file_sd/http.yml`, reload Prometheus, wait for the alert to
fire, then remove the bad target.

```bash
systemctl reload prometheus
```

## Runbooks For Baseline Alerts

### API Health Down

Check:

```bash
curl -fsS https://<app-host>/api/health
curl -fsS https://<control-plane-host>/health
systemctl status hyperspace-control-plane-api caddy --no-pager
journalctl -u hyperspace-control-plane-api -n 200 --no-pager
```

Common causes:

- API process is down.
- Caddy route is broken.
- TLS certificate expired or not deployed.
- Database connection prevents API startup.

### Gate Probe Down

Check:

```bash
curl -i https://<gate-host>/.well-known/hyperspace-probe
systemctl status caddy hyperspace-gate-agent --no-pager
journalctl -u caddy -n 100 --no-pager
```

The HTTPS probe is a browser/API reachability check. It is separate from
DoubleZero readiness.

### Host Exporter Down

Check host reachability from Prometheus:

```bash
curl -fsS http://<host>:9100/metrics | head
systemctl status prometheus-node-exporter --no-pager
```

Common causes:

- Firewall blocked `9100/tcp`.
- exporter service stopped.
- host is down or DNS changed.

### PostgreSQL Exporter Down

Check:

```bash
curl -fsS http://<db-host>:9187/metrics | grep pg_up
systemctl status prometheus-postgres-exporter --no-pager
journalctl -u prometheus-postgres-exporter -n 100 --no-pager
```

### PostgreSQL Down

Check:

```bash
systemctl status postgresql --no-pager
sudo -u postgres psql -d hyperspace -c 'select now();'
journalctl -u postgresql -n 200 --no-pager
```

### Systemd Service Down

Check:

```bash
systemctl status <service-name> --no-pager
journalctl -u <service-name> -n 200 --no-pager
```

If this alert does not evaluate, confirm node_exporter was started with the
systemd collector enabled.

### Dead Jobs Present

Inspect jobs:

```bash
curl -fsS -H "x-admin-token: ${ADMIN_TOKEN}" \
  https://<control-plane-host>/v1/admin/jobs | jq '.jobs[] | select(.phase=="dead")'
```

Then inspect gate-agent logs for the affected gate:

```bash
journalctl -u hyperspace-gate-agent -n 300 --no-pager
```

### Job Backlog High

Check whether the worker is running and whether gates are claiming jobs:

```bash
systemctl status hyperspace-control-plane-worker --no-pager
journalctl -u hyperspace-control-plane-worker -n 200 --no-pager
journalctl -u hyperspace-gate-agent -n 200 --no-pager
```

### Failed Sessions Present

Inspect public/admin session status and `session_status.last_error`:

```bash
sudo -u postgres psql -d hyperspace -c "
select sessions.id, session_status.phase, session_status.last_error
from sessions
join session_status on session_status.session_id = sessions.id
where session_status.phase = 'failed'
order by session_status.updated_at desc
limit 20;"
```

### Gate Agent Disconnected

Check:

```bash
systemctl status hyperspace-gate-agent --no-pager
journalctl -u hyperspace-gate-agent -n 300 --no-pager
curl -fsS https://<control-plane-host>/health
```

Common causes:

- gate token expired, revoked, or copied incorrectly.
- control-plane URL is wrong.
- gate cannot reach the control-plane host.
- agent is running in an unexpected environment file.

## Operations Notes

- Keep `/etc/grafana/grafana-server.env` root-owned and readable by the
  `grafana` group only.
- Treat Telegram bot tokens as production secrets.
- Keep Prometheus retention sized for your host disk. For small testnet
  deployments, 15 to 30 days is usually enough.
- Keep blackbox HTTP targets explicit. Do not probe arbitrary user-provided
  URLs from this stack.
- Use the `hyperspace-native.yml` target file only for private `/metrics`
  endpoints.
