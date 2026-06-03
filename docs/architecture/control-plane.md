# Control-Plane Architecture

The 2z WireGuard VPN control plane manages VPN sessions over DoubleZero-backed
gate paths.

```text
client
  -> ingress gate
  -> doublezero0 transit
  -> egress gate
  -> destination or Internet
```

## Component Model

- The API process exposes `/v1/public/*`, `/v1/agent/*`, `/v1/admin/*`, and
  `/v1/gate/*`.
- The worker process runs scheduling, reconciliation, expiry, retry, repair,
  and cleanup loops.
- PostgreSQL stores product and operational state.
- Gate agents run as Go binaries under systemd and use outbound poll/report.
- Caddy terminates TLS and routes traffic to the API or static web app.

## Resource Model

### Session

`Session.spec` describes user intent: mode, destinations, desired lifecycle,
TTL, path policy, and artifact policy.

`Session.status` describes observed product readiness: phase, selected path,
assignment references, artifact reference, effective expiry, errors, and
conditions.

### GateAssignment

`GateAssignment.spec` describes work on one gate for one session. A session
normally owns one ingress assignment and one egress assignment.

Each assignment has a deterministic external handle:

```text
hs-assignment-<assignment-id>
```

The handle lets an agent recover, retry, and report already-applied host state.

### Gate

`Gate.spec` declares desired scheduling state, region, endpoint, capabilities,
capacity, and required agent version.

`Gate.status` reports heartbeat freshness, observed capabilities, capacity,
headroom, and conditions such as `AgentConnected`, `Schedulable`, `Ready`, and
`Degraded`.

## Reconciliation

Controllers are level-based. Each loop reads desired state, observed state, and
latest actual host snapshot, then computes the next action.

Product readiness is derived from resource status and conditions. Jobs are
execution details and should not be the product status shown to users.

## Secrets

Private key material is never logged or stored as generic JSON payload. Use
fingerprints and encrypted payload references in plans, artifacts, jobs, logs,
and audit events.
