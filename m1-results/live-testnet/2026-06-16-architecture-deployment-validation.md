# 2026-06-16 Architecture Deployment Validation

Target deployment:

- Web/API: `https://app.testnet.hyperspace.zone`
- Public API base: `https://app.testnet.hyperspace.zone/api`
- DoubleZero network: `testnet`
- Repository commit under validation: `dc5fdb5`

Scope:

- Rechecked the primary deployment runbook in `docs/runbooks/deployment.md`.
- Verified that the existing split deployment still follows the documented upgrade path.
- Verified public web/API health, OpenAPI exposure, database migration state, Caddy configuration, gate probes, and gate schedulability.
- Ran the live UI/API smoke test after the runbook checks.

Local workspace checks:

```bash
npm run build
npm run typecheck
npm test --workspaces --if-present
```

Result: passed.

Control-plane checks:

- Node.js: `v22.22.3`
- npm: `10.9.8`
- `hyperspace-control-plane-api`: active
- `hyperspace-control-plane-worker`: active
- `caddy`: active
- `caddy validate --config /etc/caddy/Caddyfile`: valid
- `npm --prefix /opt/2z-wireguard-vpn run db:migrate`: `applied: []`
- `GET /health` on local API: OK

Database checks:

- `postgresql`: active
- database: `hyperspace`
- gate catalog size: `5`

Public entrypoint checks:

```bash
curl -fsS https://app.testnet.hyperspace.zone/api/health
curl -fsS https://app.testnet.hyperspace.zone/api/openapi.json
curl -fsS https://app.testnet.hyperspace.zone/api/v1/public/gates
```

Result:

- API health: OK
- Required OpenAPI paths present: `/health`, `/v1/public/health`, `/v1/public/auth/me`
- Gates: `5` total, `5` ready, `5` schedulable

Gate probe checks:

- `gate-ap-sin-01.testnet.hyperspace.zone`: `204 No Content`
- `gate-eu-ams-01.testnet.hyperspace.zone`: `204 No Content`
- `gate-eu-fra-01.testnet.hyperspace.zone`: `204 No Content`
- `gate-eu-lon-01.testnet.hyperspace.zone`: `204 No Content`
- `gate-na-nyc-01.testnet.hyperspace.zone`: `204 No Content`

Each probe returned `Access-Control-Allow-Origin` and `Timing-Allow-Origin` for `https://app.testnet.hyperspace.zone`.

Operational fix applied during validation:

- Ran `caddy fmt --overwrite /etc/caddy/Caddyfile` and `systemctl reload caddy` on the web, control-plane, and gate hosts.
- Revalidated that all Caddy services remained active and their configurations were valid.

Live UI/API smoke:

```bash
HS_WEB_BASE=https://app.testnet.hyperspace.zone \
HS_API_BASE=https://app.testnet.hyperspace.zone/api \
HS_TEST_OUTPUT_DIR=m1-results/live-testnet \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/snap/bin/chromium \
npm run test:live:ui
```

Result file:

- `m1-results/live-testnet/live-ui-smoke-2026-06-16T10-48-29-371Z.json`

Screenshots:

- `m1-results/live-testnet/2026-06-16T10-48-29-371Z-01-register.png`
- `m1-results/live-testnet/2026-06-16T10-48-29-371Z-02-dashboard-gates.png`
- `m1-results/live-testnet/2026-06-16T10-48-29-371Z-03-review.png`
- `m1-results/live-testnet/2026-06-16T10-48-29-371Z-04-active.png`
- `m1-results/live-testnet/2026-06-16T10-48-29-371Z-05-deleted.png`

Smoke status: passed.

Covered flow:

- Register
- Log in
- Verify dashboard gates
- Check required explicit egress validation
- Request config
- Wait for active config
- Validate raw WireGuard config
- Click UI download
- Revoke config
- Delete config

No browser console errors or page errors were recorded.
