# PostgreSQL

PostgreSQL is the transaction source of truth for the control plane.

Recommended target:

- host: private DNS or private IP reachable only from the control plane
- database: dedicated application database
- runtime: native OS packages and systemd
- access: restricted to control-plane hosts

Minimum bootstrap sequence:

```bash
apt-get update
apt-get install -y postgresql postgresql-contrib
```

Apply migrations from `packages/db/migrations` with a migration runner during
deployment. The database must not be exposed publicly.

Install cluster-local host and PostgreSQL monitoring from a repository checkout:

```bash
scripts/observability/install-service-node-exporter \
  --listen-ip <private-or-public-scrape-ip> \
  --observability-ip <this-cluster-observability-ip>
scripts/observability/install-postgres-monitoring \
  --listen-ip <private-or-public-scrape-ip> \
  --observability-ip <this-cluster-observability-ip> \
  --database hyperspace
```

The installer uses local peer authentication for the `prometheus` PostgreSQL
role and stores no database password. TCP/9100 and TCP/9187 are accepted only
from the same cluster's observability host. TCP/5432 is additionally allowed
from that host for the blackbox reachability probe without changing existing
application database access.

The health collector discovers the newest
`/var/backups/hyperspace/hyperspace-*.dump`. Install the repository backup timer
with `scripts/db/install-backup`, or point `HS_DB_BACKUP_DIR` in
`/etc/hyperspace/postgres-monitoring.env` at the real backup directory. A
missing dump is a real critical alert, not an exporter setup condition.
