# Repository Guidelines

## Project Structure

- `apps/control-plane-api` - HTTPS API process for public, agent, admin, and gate surfaces.
- `apps/control-plane-worker` - scheduler, reconciler, expiry, retry, and cleanup process.
- `apps/gate-agent` - Go gate agent installed on gate hosts.
- `apps/web` - management UI.
- `packages/contracts` - schema-first contracts and shared resource types.
- `packages/db` - PostgreSQL migrations and database helpers.
- `packages/shared` - shared TypeScript utilities.
- `infra` - Caddy, systemd, PostgreSQL, and observability assets.
- `docs` - architecture, API, runbook, and operations documentation.

## Development Commands

- `npm install` - install workspace dependencies.
- `npm run build` - build TypeScript workspaces.
- `npm test` - run TypeScript test suites when present.
- `cd apps/gate-agent && go test ./...` - run Go checks.

## Architecture Rules

- PostgreSQL is the transaction source of truth.
- API and worker are separate processes from the same backend codebase.
- Gate hosts use outbound poll/report only.
- Core resources use `spec`, `status`, `generation`, `observedGeneration`, and `conditions`.
- Gate application and revocation are idempotent and use deterministic external handles.
- Do not log private keys, tokens, raw WireGuard configs, or decrypted artifacts.

## Runtime Rules

Prefer bare-metal packages and systemd units. Do not introduce Docker unless a
future deployment decision explicitly requires it.
