# PostgreSQL hot-data and NFS history archive

The control-plane PostgreSQL database is the source of truth for live product
state. High-volume synthetic measurements and completed queue attempts are not
kept indefinitely in the hot database. They are first archived to the
provider-managed NFS volume as verified, compressed JSONL and are then removed
in small batches.

## Retention policy

| Dataset | Hot retention | Durable copy |
| --- | ---: | --- |
| gate benchmark results and completed probe jobs | complete UTC day plus 1 day | NFS JSONL.zst |
| trading probe jobs and attempts | complete UTC day plus 1 day | NFS JSONL.zst |
| non-probe control jobs | 30 days | NFS JSONL.zst |
| five-minute trading rollups | 30 days | NFS JSONL.zst |
| assignment counters and usage deltas | 90 days | NFS JSONL.zst |
| current state, latest measurements, sessions, ledger and audit | not archived by this job | PostgreSQL |

The time boundary is a complete UTC day. The archiver never removes queued,
leased, running or retryable work. Billing ledger records are never archive
targets. Assignment usage is retained for 90 days in PostgreSQL and archived
with both the source counter and calculated delta.

## Safety and load control

`hyperspace-pg-history-archive` requires an exact NFS/NFSv4 mount and refuses
to run when the volume has less than 15% or 10 GiB available. Each table slice
is streamed through single-threaded zstd. It is published only after zstd
validation, an exact row-count comparison, SHA-256 generation, filesystem
flush and a `READY` marker. Deletion then uses 5,000-row
`FOR UPDATE SKIP LOCKED` batches with pauses. An unavailable or incomplete
archive therefore deletes nothing.

The systemd unit runs with low CPU and I/O priority. By default it processes
one UTC-day slice per dataset at 04:30 UTC, away from the 02:15 database dump.
It pauses when more than four other PostgreSQL queries are active. Initial
catch-up may temporarily raise `HS_DB_HISTORY_ARCHIVE_MAX_SLICES_PER_RUN`, but
must be monitored and returned to `1` afterwards.

Install on the DB host from the matching deployed branch:

```bash
scripts/db/install-history-archive
editor /etc/hyperspace/db-history-archive.env
systemctl start hyperspace-db-history-archive.service
systemctl status hyperspace-db-history-archive.timer
```

Set `HS_CLUSTER` and the real mount/root paths. Production currently uses
`/mnt/hyperspace-backup`; staging uses `/var/backups/hyperspace`.

Before the first run on an existing large database, build the retention and
foreign-key indexes without blocking writes:

```bash
DATABASE_URL=... node scripts/db/prebuild-history-archive-indexes.mjs
npm run db:migrate
```

Archive layout:

```text
<archive-root>/<cluster>/<dataset>/YYYY-MM-DD/
  <table>.jsonl.zst
  <table>.jsonl.zst.sha256
  <table>.jsonl.zst.rows
  MANIFEST
  READY
  COMPLETE
```

`READY` means every file was verified before deletion began. `COMPLETE` means
the matching hot rows were removed. A restore imports JSON objects into a
schema-compatible scratch table with `jsonb_populate_record`; do not restore
operational history directly into a live queue.

## Capacity and compaction

Alerts fire at 24 GiB (warning) and 30 GiB (critical) for the hot database,
and also cover archive failure, staleness and NFS capacity. `DELETE` makes
space reusable by PostgreSQL but does not return existing relation files to
the operating system. After the initial archive catch-up, use `pg_repack` one
large table at a time to establish a compact baseline without `VACUUM FULL`.
Do not schedule routine repacks: autovacuum should reuse the reclaimed pages.

The production 100-GB NFS volume shares capacity with three verified database
dumps. It is enough for initial catch-up only while the safety reserve remains;
500 GB is the recommended tier for long-lived history retention.
