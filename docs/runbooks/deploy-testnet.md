# Deploy Testnet

This runbook describes the intended bare-metal deployment shape.

## Database

1. Install PostgreSQL on `db.testnet.hyperspace.zone`.
2. Create the `hyperspace` database and least-privilege application user.
3. Restrict PostgreSQL access to control-plane hosts.
4. Apply migrations from `packages/db/migrations`.
5. Configure backups and verify restore procedure.

## Control Plane

1. Install Node.js active LTS.
2. Build the TypeScript workspace.
3. Install `hyperspace-control-plane-api.service`.
4. Install `hyperspace-control-plane-worker.service`.
5. Configure Caddy for `control-plane.testnet.hyperspace.zone`.
6. Verify `/health` and all API surface health endpoints.

## Web

1. Build `apps/web`.
2. Sync static assets to `/var/www/hyperspace-web`.
3. Install Caddy config for `app.testnet.hyperspace.zone`.

## Gates

1. Install `wireguard-tools`, `iproute2`, `nftables`, and diagnostics tools.
2. Install the `hyperspace-gate-agent` binary.
3. Install `hyperspace-gate-agent.service`.
4. Register each gate in PostgreSQL.
5. Enable gates only after heartbeat, actual-state reporting, and DoubleZero
   reachability checks pass.

## Observability

1. Install Prometheus and Grafana on `observability.testnet.hyperspace.zone`.
2. Install node_exporter on all hosts.
3. Install postgres_exporter on the database host.
4. Add API, worker, and gate-agent metrics scrape targets.
