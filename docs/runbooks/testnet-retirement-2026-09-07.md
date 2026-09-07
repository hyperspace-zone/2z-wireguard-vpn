# Testnet retirement — 2026-09-07

The Hyperspace DoubleZero testnet environment was intentionally retired after
coordination with the DoubleZero team. This is a reversible cold shutdown, not
a data deletion. Production and staging use DoubleZero mainnet-beta and are not
part of this procedure.

## Final state

- Alertmanager on the testnet observability host was silenced for all alerts
  before shutdown, through 2036-09-07.
- The testnet meta-monitor was disabled. The active meta-monitor ring is now
  `production → staging → production`; neither active environment probes the
  retired testnet endpoint.
- Four historical sessions with `desired_state=Active` were system-revoked.
  The final database state contains 169 revoked sessions and no active or
  revoking session or assignment.
- All five gates and all five trading probe identities have desired state
  `Disabled`.
- `hyperspace-gate-agent`, `hyperspace-trading-probe-agent`, Caddy, node
  exporter, and `doublezerod` are disabled on all testnet gates. Every gate was
  disconnected with `doublezero disconnect ibrl` and reported `disconnected`
  with no session data.
- API, worker, web, PostgreSQL, backup timers, exporters, Prometheus,
  Alertmanager, Grafana, blackbox exporter, gate discovery, and Caddy are
  stopped and disabled on the four service hosts. SSH remains available for
  recovery until the provider instances are powered off.

## Final backup

The final custom-format PostgreSQL dump passed `pg_restore --list`:

```text
/var/backups/hyperspace/hyperspace-20260907T075649Z.dump
size: 2427774090 bytes
```

It is stored in the encrypted Cloudflare R2 Restic repository as snapshot
`5081ad96`. Retention was corrected to group by `host,tags`; the repository now
contains three snapshots and approximately 3.62 GiB of raw data. The two other
retained restore points are `7790caca` (2026-09-05) and `64bdd689`
(2026-09-06).

The bucket-scoped S3 credentials and independent Restic encryption password
were copied before shutdown to the root-only, non-repository file
`/root/hyperspace/.provider_creds/cloudflare_r2/hyperspace-testnet-postgres-backups.env`
with mode `0600`. This file is required to restore after deleting the DB disk.

## Provider shutdown inventory

| Role | Host/IP |
| --- | --- |
| Web | `app.testnet.hyperspace.zone` / `212.147.234.79` |
| Control plane | `control-plane.testnet.hyperspace.zone` / `81.27.100.130` |
| PostgreSQL | `db.testnet.hyperspace.zone` / `81.27.100.29` |
| Observability | `observability.testnet.hyperspace.zone` / `81.27.101.158` |
| Gate Frankfurt | `gate-eu-fra-01` / `212.147.230.200` |
| Gate Amsterdam | `gate-eu-ams-01` / `85.9.219.252` |
| Gate Singapore | `gate-ap-sin-01` / `213.163.192.30` |
| Gate London | `gate-eu-lon-01` / `94.237.62.140` |
| Gate New York | `gate-na-nyc-01` / `85.9.199.104` |

Power off the provider instances only after matching both hostname and public
IP. Do not delete DNS while powered-off instances retain their IPs. If an
instance is terminated and its IP is released, remove its DNS record promptly
to prevent a stale record from pointing to a future tenant.

UpCloud `Stop` does not necessarily stop billing. Starter and Premium plans
remain billed while powered off. Cloud Native compute is not billed while
stopped, but attached storage and allocated public IP addresses remain billed.
To reduce the retired environment to zero provider cost, verify the R2 restore
point first, then delete the server resources, storage, backups, and reserved
IPs rather than only stopping the instances. See the current
[UpCloud Cloud Server configuration and billing documentation](https://upcloud.com/docs/products/cloud-servers/configurations/).

## Recovery order

1. Start PostgreSQL and verify the database, or restore snapshot `5081ad96`.
2. Start the control-plane API and worker, then the web service.
3. Start observability, remove the retirement silence, and add testnet back to
   the active meta-monitor ring.
4. Start `doublezerod`, run `doublezero connect ibrl`, then start the gate and
   trading probe agents.
5. Change gate and trading-probe desired states from `Disabled` only after
   heartbeats, DoubleZero readiness, and probe self-tests are healthy.
