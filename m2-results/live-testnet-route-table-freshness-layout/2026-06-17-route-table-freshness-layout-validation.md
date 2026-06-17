# Route table freshness and layout validation

Date: 2026-06-17

Branch: `milestone2-benchmarking-monitoring`

Live target: `https://app.testnet.hyperspace.zone`

Validated changes:

- benchmark freshness now shows latest sample plus transport freshness coverage:
  `Latest sample ... · N/N transports fresh within 15m`
- the route table uses a directed city pair in the first column (`City1 -> City2`)
  and keeps the gate pair as secondary text
- the separate `Cities` column was removed
- visible `Advantage` wording was replaced with `Improvement`
- the table includes a sortable `Jitter` column with DZ/Internet jitter values and
  jitter improvement
- `DZ One-Way` and `Internet One-Way` remain separate sortable forward one-way
  columns
- the `All cities` filter was tightened and aligned horizontally with the
  `Showing all directed routes.` status text

Validation:

- `npm run typecheck --workspace @hyperspace-zone/web`
- `npm run build --workspace @hyperspace-zone/web`
- `git diff --check`
- `HS_TEST_OUTPUT_DIR=m2-results/live-testnet-route-table-freshness-layout npm run test:live:ui`

Smoke result:

- run id: `2026-06-17T05-09-27-451Z`
- status: `passed`
- console errors: none
- page errors: none

Primary screenshot:

- `2026-06-17T05-09-27-451Z-02-dashboard-gates.png`
