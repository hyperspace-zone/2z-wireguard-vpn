# Temporary staging retirement — 2026-09-22

The staging environment was intentionally retired on 2026-09-22. It is
disposable and will be rebuilt from source, migrations, and deployment
automation if another pre-production environment is required. No PostgreSQL or
infrastructure backup is retained as a recovery source.

## Removed service hosts

| Role | Historical hostname | Historical public IPv4 |
| --- | --- | --- |
| Web | `app.staging.hyperspace.zone` | `84.32.25.11` |
| API and worker | `control-plane.staging.hyperspace.zone` | `84.32.83.198` |
| PostgreSQL | `db.staging.hyperspace.zone` | `84.32.97.140` |
| Observability | `observability.staging.hyperspace.zone` | `84.32.110.4` |

All four VMs were terminated at Cherry Servers. These addresses are historical
only and must not remain in DNS or deployment inventories because the provider
may reassign them.

## Gate disposition

- `gate-eu-mad-01` and `gate-na-chi-02` were moved to production and remain
  production infrastructure.
- `gate-ap-hkg-31` was retired with the former is*hosting fleet.
- Production gate and trading-probe catalogs no longer contain the retired
  is*hosting hosts.

## Monitoring state

Production `/etc/hyperspace/meta-watch-peers.tsv` is intentionally empty while
there is no second active environment. The production meta-monitor continues
to validate its local Alertmanager and notification delivery. Do not add a
staging peer until its replacement observability endpoint is deployed and
healthy.

## Rebuild order

1. Provision PostgreSQL and run all migrations from the selected staging
   branch revision.
2. Provision the control-plane API and worker with new staging-only secrets.
3. Provision the web host and restore the staging DNS names with newly assigned
   addresses.
4. Provision observability, staging-only Telegram routing, and database backup
   storage if backups are desired for the new environment.
5. Add dedicated staging gates or transfer selected gates from production only
   after the new control plane is healthy.
6. Add the new observability endpoint back to the production meta-watch peer
   file and verify both directions before enabling staging alert delivery.

Never reuse the historical VM addresses, gate tokens, probe tokens, database
credentials, or Telegram routing files without rotating them.
