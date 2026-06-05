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
