# Route table benchmark UI validation

Date: 2026-06-16
Branch: `milestone2-benchmarking-monitoring`
Environment: `https://app.testnet.hyperspace.zone`

## UI change

The benchmark dashboard no longer renders a horizontal gate-to-gate matrix.
It renders a route table modeled after the Lake `DZ vs Internet` page:

- one row per directed gate pair
- sortable columns for route, city, DZ RTT, public RTT, DZ advantage, RTT saved,
  DZ jitter, public jitter, and loss
- city filter instead of metro terminology
- green/yellow/pink legend:
  - DZ faster
  - Similar
  - Public Internet faster

This layout is intended to scale to a larger footprint such as 29 points of
presence without expanding horizontally by PoP count.

## Live smoke

Smoke file: `live-ui-smoke-2026-06-16T15-43-45-418Z.json`

- Status: `passed`
- Session: `32118374-ce6d-4b65-a7dc-fc2d9a42d4a4`
- Console errors: 0
- Page errors: 0

Dashboard screenshot:

- `2026-06-16T15-43-45-418Z-02-dashboard-gates.png`

The screenshot shows the route table sorted by DZ advantage descending, with
failed/n/a values placed after comparable rows.
