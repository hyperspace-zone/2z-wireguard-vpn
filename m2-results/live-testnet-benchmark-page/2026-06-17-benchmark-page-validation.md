# Benchmark page validation

Date: 2026-06-17

Branch: `milestone2-benchmarking-monitoring`

Live target: `https://app.testnet.hyperspace.zone`

Validated changes:

- top navigation now includes `Dashboard`, `Create config`, and `Benchmarks`
- the dashboard keeps `VPN configs` and `Gates` only
- the gate benchmark route table is no longer rendered on the dashboard
- `/benchmarks` renders `Gate benchmark routes` with the existing `DZ vs Internet`
  route table, city filter, freshness coverage, split jitter columns, one-way
  columns, and legend

Validation:

- `npm run typecheck --workspace @hyperspace-zone/web`
- `npm run build --workspace @hyperspace-zone/web`
- `git diff --check`
- `HS_TEST_OUTPUT_DIR=m2-results/live-testnet-benchmark-page npm run test:live:ui`

Smoke result:

- run id: `2026-06-17T05-30-16-071Z`
- status: `passed`
- console errors: none
- page errors: none

Primary screenshots:

- dashboard: `2026-06-17T05-30-16-071Z-02-dashboard-gates.png`
- benchmarks: `2026-06-17T05-30-16-071Z-03-benchmarks.png`
