# Symmetric public probe validation

Date: 2026-06-16
Branch: `milestone2-benchmarking-monitoring`
Environment: `https://app.testnet.hyperspace.zone`

## Fix

Gate-agent UDP benchmark responders now open interface-bound sockets on the same
probe port:

- public responder bound to the default public underlay interface, `eth0` on
  the current testnet gates
- DoubleZero responder bound to `doublezero0`

Replies are sent from the same bound socket that received the probe. This keeps
the measured public path symmetric instead of letting the target gate route the
reply back through `doublezero0`.

## Benchmark matrix snapshot

Snapshot file: `../live-testnet/gate-benchmark-matrix-2026-06-16T15-28-59Z.json`

- Gates: 5
- Directed routes: 20
- Pending route cells: 0
- Public transport succeeded: 20
- Public transport failed: 0
- DoubleZero transport succeeded: 18
- DoubleZero transport failed: 2

The remaining two failures are DoubleZero-bound FRA <-> NYC probes and are
separate from the public underlay benchmark path.

## UI smoke

Smoke file: `live-ui-smoke-2026-06-16T15-29-18-466Z.json`

- Status: `passed`
- Session: `98832ada-d8f1-485f-b9b7-df25effc42e5`
- Console errors: 0
- Page errors: 0

Dashboard screenshot:

- `2026-06-16T15-29-18-466Z-02-dashboard-gates.png`

The dashboard screenshot shows public RTT, DoubleZero RTT, deltas, and loss for
the directed gate matrix after symmetric responder binding.
