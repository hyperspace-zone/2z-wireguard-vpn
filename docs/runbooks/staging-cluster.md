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

PostgreSQL accepts port 5432 only from the control-plane private address.
Worker metrics on port 9091 accept traffic only from the observability private
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

## Validation

```bash
curl -fsS https://app.staging.hyperspace.zone/api/health
curl -fsS https://app.staging.hyperspace.zone/api/v1/public/gates | jq .
curl -fsS https://app.staging.hyperspace.zone/api/v1/public/benchmarks/gate-matrix | jq .
curl -fsS https://observability.staging.hyperspace.zone/prometheus/api/v1/targets | jq .
curl -fsS https://observability.staging.hyperspace.zone/prometheus/api/v1/alerts | jq .
```

Acceptance requires all five Prometheus targets up, no unexplained firing
alerts, six fresh directed benchmark routes, and a passing browser billing and
config-lifecycle E2E.

## External Configuration

Before authentication acceptance:

1. Add
   `https://app.staging.hyperspace.zone/api/v1/public/auth/google/callback`
   to the Google OAuth client's authorized redirect URIs and add
   `https://app.staging.hyperspace.zone` as an authorized JavaScript origin.
2. Store a separate Resend Full Access key as `RESEND_RECEIVING_API_KEY` only in
   the E2E runner. The runtime API uses its send-only key.
3. Configure staging-specific Alertmanager Telegram recipients. Until then the
   staging Alertmanager uses the intentional null receiver and does not send
   staging incidents into production channels.

The staging API and worker receive their control-plane-only Solana mainnet
endpoint as `SOLANA_RPC_URL` through runtime environment configuration or secret
management. If that node does not retain transaction history, set
`SOLANA_ARCHIVAL_RPC_URL` on the API to a read-only archival endpoint so an
already submitted payment can be reconciled without a second transfer. Never
commit private or credential-bearing endpoints. The placeholders
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
