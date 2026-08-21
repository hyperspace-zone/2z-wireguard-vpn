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

For an encrypted offsite copy, create `/etc/hyperspace/db-backup-offsite.env`
with `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, provider credentials, and an
optional `RESTIC_CACHE_DIR`. Restrict the file to root (`0600`) before running
`scripts/db/install-backup`. The backup job verifies the PostgreSQL custom
dump, uploads the dump and cluster globals through Restic, checks the remote
repository, retains seven daily and four weekly snapshots, and records a
separate offsite-success timestamp. Set the following on the monitored DB host:

```dotenv
HS_DB_OFFSITE_BACKUP_ENABLED=1
HS_DB_OFFSITE_SUCCESS_FILE=/var/lib/hyperspace/db-backup/offsite-last-success
```

The local dump and offsite timestamp have independent critical alerts. Never
commit the Restic password or object-storage credentials.

For a provider-managed NFS backup volume, mount the export exactly at
`/var/backups/hyperspace` and configure:

```dotenv
HS_DB_OFFSITE_BACKUP_MODE=filesystem
HS_DB_OFFSITE_FILESYSTEM_TYPE=nfs4
HS_DB_OFFSITE_SUCCESS_FILE=/var/lib/hyperspace/db-backup/offsite-last-success
```

The backup job checks the exact mount and filesystem type before creating a
dump, flushes verified files to the remote filesystem, and only then records
offsite success. If the mount is absent it fails closed rather than filling the
local root filesystem.
