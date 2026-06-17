# Split One-Way benchmark table validation

Date: 2026-06-17

Branch: `milestone2-benchmarking-monitoring`

Live target: `https://app.testnet.hyperspace.zone/benchmarks`

Validated changes:

- the Benchmarks page now renders `Gate benchmark routes — RTT` and
  `Gate benchmark routes — One-Way` as separate tables
- the RTT table contains RTT, RTT improvement, RTT saved, RTT jitter metrics,
  and loss
- the One-Way table contains `DZ One-Way`, `Internet One-Way`,
  `One-Way Improvement`, and `One-Way Saved`
- RTT and One-Way tables have independent sortable columns
- Dashboard no longer renders benchmark route tables
- logout/browser RTT measurement rendering no longer races with the login form

Validation:

- `npm run typecheck --workspace @hyperspace-zone/web`
- `npm run build --workspace @hyperspace-zone/web`
- `git diff --check`
- `HS_TEST_OUTPUT_DIR=m2-results/live-testnet-benchmark-page-split-oneway npm run test:live:ui`

Smoke result:

- run id: `2026-06-17T05-48-36-791Z`
- status: `passed`
- console errors: none
- page errors: none

Primary screenshots:

- dashboard: `2026-06-17T05-48-36-791Z-02-dashboard-gates.png`
- benchmarks: `2026-06-17T05-48-36-791Z-03-benchmarks.png`
