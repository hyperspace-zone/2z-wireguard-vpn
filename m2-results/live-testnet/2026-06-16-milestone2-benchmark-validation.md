# Milestone 2 benchmark validation

Date: 2026-06-16
Branch: `milestone2-benchmarking-monitoring`
Environment: `https://app.testnet.hyperspace.zone`

## Deployed scope

- Control-plane API and worker deployed on `control-plane.testnet.hyperspace.zone`.
- Web dashboard deployed on `app.testnet.hyperspace.zone`.
- Gate agent deployed on all 5 testnet gates.
- UDP benchmark responder enabled on port `19192` with HMAC enabled.
- Chrony installed and active on all gates for one-way timestamp estimates.

## Benchmark matrix snapshot

Snapshot file: `gate-benchmark-matrix-2026-06-16T11-48-31Z.json`

- Gates: 5
- Directed routes: 20
- Pending route cells: 0
- Public transport succeeded: 2
- Public transport failed: 18
- DoubleZero transport succeeded: 18
- DoubleZero transport failed: 2

Observed behavior in this testnet footprint:

- Most public gate-to-gate probes on UDP `19192` are blocked or unreachable on the public underlay.
- The same representative routes generally succeed when the socket is bound to `doublezero0`.
- FRA <-> NYC is the opposite case in this sample: public succeeds while DoubleZero-bound probes fail.

## UI smoke

Smoke file: `live-ui-smoke-2026-06-16T11-44-17-719Z.json`

- Status: `passed`
- Session: `d9424157-ee91-464f-9f4d-83fae7d44fbb`
- Web base: `https://app.testnet.hyperspace.zone`
- API base: `https://app.testnet.hyperspace.zone/api`
- Console errors: 0
- Page errors: 0

Covered steps:

- register/login
- dashboard gates check
- egress validation
- VPN config issue/manage lifecycle
- benchmark dashboard text checks for `Gate benchmark matrix`, `RTT comparison`, and `One-way probes`

## Screenshots

- `2026-06-16T11-44-17-719Z-01-register.png`
- `2026-06-16T11-44-17-719Z-02-dashboard-gates.png`
- `2026-06-16T11-44-17-719Z-03-review.png`
- `2026-06-16T11-44-17-719Z-04-active.png`
- `2026-06-16T11-44-17-719Z-05-deleted.png`

The dashboard screenshot `02-dashboard-gates` includes both benchmark matrices:

- RTT comparison: DoubleZero vs public RTT/loss per directed gate pair.
- One-way probes: forward/reverse DoubleZero and public estimates per directed gate pair.
