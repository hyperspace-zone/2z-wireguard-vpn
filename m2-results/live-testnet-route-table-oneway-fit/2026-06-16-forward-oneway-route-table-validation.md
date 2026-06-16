# Forward one-way route table validation

Date: 2026-06-16
Branch: `milestone2-benchmarking-monitoring`
Environment: `https://app.testnet.hyperspace.zone`

## UI change

The benchmark route table now uses the same terminology as the Lake
`DZ vs Internet` page:

- `Public` is not used for benchmark transport labels in the UI.
- RTT columns are `DZ RTT` and `Internet RTT`.
- Jitter columns are `DZ Jitter` and `Internet Jitter`.
- One-way latency is split into sortable `DZ One-Way` and `Internet One-Way`
  columns.
- Only forward one-way is displayed, because every table row is already a
  directed route.
- The green/yellow/pink legend is preserved with `Internet faster` wording.

The table layout was tightened so the 11 route columns fit the dashboard panel
without depending on a wide all-to-all matrix.

## Live smoke

Smoke file: `live-ui-smoke-2026-06-16T15-58-25-827Z.json`

- Status: `passed`
- Session: `d3d78fb0-5dbd-4dc9-9098-53a8fd99249b`
- Console errors: 0
- Page errors: 0

Dashboard screenshot:

- `2026-06-16T15-58-25-827Z-02-dashboard-gates.png`
