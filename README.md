# 2z WireGuard VPN

2z WireGuard VPN is a session-oriented control plane for WireGuard VPN paths
carried over DoubleZero transit.

The system manages external state on distributed gate hosts: WireGuard peers,
policy routing, nftables rules, transit through `doublezero0`, session expiry,
revocation, recovery, and operator-visible audit.

## Architecture

```text
Browser / pay.sh / Operators
          |
          | HTTPS
          v
        Caddy
          |
          v
Control-Plane API  <---->  PostgreSQL
 Fastify + TypeScript          ^
 /v1/public/*                  |
 /v1/agent/*                   |
 /v1/admin/*                   |
 /v1/gate/*                    |
          ^                    |
          |                    |
Control-Plane Worker ----------+
 scheduler / reconciler / expiry
          ^
          |
 outbound HTTPS poll/report
          |
          v
Gate Agent
 Go + systemd + wg/ip/nft
          |
          v
Gate Host + doublezero0
```

The control plane follows a declarative resource model:

- `Session` describes the VPN product intent.
- `GateAssignment` describes the desired work on one gate.
- `Gate` describes a managed gate host and scheduling state.
- `RenderedPlan` is immutable per session generation.
- `Artifact` controls client config issuance and invalidation.
- `Job` and `JobAttempt` provide row-level leased execution history.

## Repository Layout

```text
apps/
  control-plane-api/      Fastify API process
  control-plane-worker/   scheduler, reconciler, expiry process
  gate-agent/             Go gate agent
  web/                    management UI
packages/
  contracts/              schema-first API and resource contracts
  db/                     PostgreSQL migrations and SQL helpers
  shared/                 shared TypeScript utilities
infra/
  caddy/                  Caddy entrypoint templates
  systemd/                bare-metal service units
  postgres/               PostgreSQL deployment notes
  observability/          metrics and logging deployment notes
docs/
  architecture/           target architecture documentation
  api/                    API surface documentation
  runbooks/               testnet and deployment runbooks
  operations/             security and operational procedures
```

## Testnet Topology

The beta testnet uses bare-metal systemd services and does not require Docker.

| Role | Hostname |
| --- | --- |
| Web | `app.testnet.hyperspace.zone` |
| Control plane | `control-plane.testnet.hyperspace.zone` |
| Database | `db.testnet.hyperspace.zone` |
| Observability | `observability.testnet.hyperspace.zone` |
| FRA gate | `gate-eu-fra-01.testnet.hyperspace.zone` |
| AMS gate | `gate-eu-ams-01.testnet.hyperspace.zone` |
| LON gate | `gate-eu-lon-01.testnet.hyperspace.zone` |
| NYC gate | `gate-na-nyc-01.testnet.hyperspace.zone` |
| SIN gate | `gate-ap-sin-01.testnet.hyperspace.zone` |

## Development

Install Node.js active LTS and Go 1.23 or newer.

```bash
npm install
npm run build
npm test
```

Gate agent checks:

```bash
cd apps/gate-agent
go test ./...
```

## Deployment Model

Deployment is intentionally package-and-systemd oriented:

- PostgreSQL runs as a native service on the database host.
- API and worker run as separate systemd services from the same codebase.
- Gate agent runs as a Go binary under systemd.
- Caddy terminates TLS and routes API/web traffic.
- Observability is provided by Prometheus, Grafana, and exporters.

## License

This project is licensed under the Apache License, Version 2.0.
