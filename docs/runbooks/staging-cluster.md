# Staging Cluster

The staging environment runs an isolated Hyperspace control plane over
DoubleZero `mainnet-beta`. It is intended for Milestone 3 billing, authentication,
config lifecycle, and release acceptance without changing production data or
issuing production configs.

## Topology

| Role | Public endpoint | Public IPv4 | Private IPv4 |
| --- | --- | --- | --- |
| Web | `app.staging.hyperspace.zone` | `84.32.25.11` | `10.179.228.40` |
| API and worker | `control-plane.staging.hyperspace.zone` | `84.32.83.198` | `10.179.228.44` |
| PostgreSQL | `db.staging.hyperspace.zone` | `84.32.97.140` | `10.179.228.4` |
| Observability | `observability.staging.hyperspace.zone` | `84.32.110.4` | `10.179.228.54` |

PostgreSQL accepts port 5432 from the control-plane private address and from the
observability private address used by the cluster-local TCP probe. Worker
metrics on port 9091 accept traffic only from the observability private
address. Prometheus, Alertmanager, and Grafana bind to loopback behind Caddy.
Public hosts expose only SSH and the HTTP/HTTPS ports required by their role.

All four hosts use the Ubuntu HWE kernel, a persistent 2 GiB swap file, bounded
journald storage, and disabled unattended-upgrade, PackageKit, and firmware
timers. Secrets live in root-readable environment files on the target hosts and
must not be committed.

## Staging Gates

| Gate | Public IPv4 | Production state | Staging state |
| --- | --- | --- | --- |
| `gate-ap-tyo-21` | `88.216.188.7` | `Maintenance` | `Enabled` |
| `gate-eu-ams-21` | `84.32.231.46` | `Maintenance` | `Enabled` |
| `gate-na-chi-02` | `152.44.43.130` | `Maintenance` | `Enabled` |

Each gate has an independent staging agent token and reports only to
`control-plane.staging.hyperspace.zone`. Do not set the same gate to `Enabled`
in two control planes. A transfer is complete only when production reports
`Maintenance` and `schedulable=false`, while staging reports `Enabled`,
`ready=true`, and `schedulable=true`.

Browser probes use an explicit CORS allowlist containing both production and
staging app origins. Deploy it with repeated options:

```bash
scripts/gates/deploy-agent \
  ... \
  --web-origin https://app.hyperspace.zone \
  --web-origin https://app.staging.hyperspace.zone
```

When bootstrapping these gates for staging, pass
`--observability-ip 84.32.110.4`. The provisioning service persists the scoped
TCP/9100 and inventory-derived UDP/19192 UFW rules across reboot. If a gate is
regularly transferred between staging and production, pass both observability
IPv4s as repeated options.

The three gates run the same current DoubleZero package and passive route
liveness profile documented in the main deployment runbook. Verify all six
directed benchmark routes after any package update.

## Database Backup

Install the daily custom-format PostgreSQL backup from a repository checkout on
the database host:

```bash
scripts/db/install-backup
systemctl list-timers hyperspace-db-backup.timer
find /var/backups/hyperspace -type f -name 'hyperspace-*.dump'
```

The service validates each archive with `pg_restore --list`, publishes it
atomically, and retains 14 days by default. Override the database, directory, or
retention in `/etc/hyperspace/db-backup.env`.

## Service Host Monitoring

Install the repository-managed node exporter on the web, control-plane, and
database hosts. The observability host uses the package-managed node exporter,
but must use the same textfile collector directory. Every exporter is bound to
the host's staging private IPv4 and protected so only the staging observability
host can scrape it:

```bash
# Run on web, control-plane, and database hosts with the host-specific IP.
scripts/observability/install-service-node-exporter \
  --listen-ip <host-private-ip> \
  --observability-ip 10.179.228.54

# Run on the PostgreSQL host after PostgreSQL itself is configured.
scripts/observability/install-postgres-monitoring \
  --listen-ip 10.179.228.4 \
  --observability-ip 10.179.228.54 \
  --database hyperspace
```

The PostgreSQL installer creates a local peer-authenticated `prometheus` role
with `pg_monitor`, installs `postgres_exporter`, and schedules the supplementary
health collector. It does not create or store a database password. Verify the
services and collectors before configuring Prometheus:

```bash
systemctl is-active prometheus-node-exporter
systemctl is-active prometheus-postgres-exporter
systemctl is-active hyperspace-postgres-health-exporter.timer
systemctl is-active hyperspace-monitoring-firewall.service
```

Install `prometheus-blackbox-exporter` on the staging observability host and use
`infra/observability/blackbox/blackbox.yml`. The staging Prometheus file probes
the app root, app `/api/health`, control-plane `/health`, PostgreSQL TCP/5432,
and TLS certificate lifetime without contacting another Hyperspace cluster.

## Validation

```bash
curl -fsS https://app.staging.hyperspace.zone/api/health
curl -fsS https://app.staging.hyperspace.zone/api/v1/public/gates | jq .
curl -fsS https://app.staging.hyperspace.zone/api/v1/public/benchmarks/gate-matrix | jq .
curl -fsS https://observability.staging.hyperspace.zone/prometheus/api/v1/targets | jq .
curl -fsS https://observability.staging.hyperspace.zone/prometheus/api/v1/alerts | jq .
```

Acceptance requires all four `hyperspace-host-node` targets, the PostgreSQL
exporter, all three HTTP probes, and the PostgreSQL TCP probe to be up. It also
requires no unexplained firing alerts, six fresh directed benchmark routes, and
a passing browser billing and config-lifecycle E2E.

## External Configuration

Before authentication acceptance:

1. Add
   `https://app.staging.hyperspace.zone/api/v1/public/auth/google/callback`
   to the Google OAuth client's authorized redirect URIs and add
   `https://app.staging.hyperspace.zone` as an authorized JavaScript origin.
2. Store a separate Resend Full Access key as `RESEND_RECEIVING_API_KEY` only in
   the E2E runner. The runtime API uses its send-only key.
3. Store the staging Telegram bot token only in
   `/etc/prometheus/telegram_bot_token`, render receivers from
   `infra/observability/alertmanager/telegram-receivers.staging.example.json`,
   and validate the result with `amtool check-config`. The checked-in receiver
   file routes all severities to the staging group and operator account, and
   critical alerts to the staging critical channel. Change recipient IDs in a
   deployment-local receiver file when a different staging audience is needed;
   never send staging incidents into production channels.

The staging API and worker receive their control-plane-only Solana mainnet
endpoint as `SOLANA_RPC_URL` through runtime environment configuration or secret
management. Never commit private or credential-bearing endpoints. The
placeholders
`https://solana-rpc.example.invalid` and `wss://solana-rpc.example.invalid` are
intentionally non-resolving; the WebSocket value is not used by the current HTTP
polling implementation. Do not copy a mainnet endpoint into the Solana testnet
contour.

## Rollback

To return a gate to production, first set it to `Maintenance` in staging and
wait for assignments to reach zero. Restore its production
`/etc/hyperspace/gate-agent.env`, restart `hyperspace-gate-agent`, and only then
set the production catalog record to `Enabled`. Re-run catalog, heartbeat,
DoubleZero route, benchmark, and browser CORS checks before making it
schedulable.
