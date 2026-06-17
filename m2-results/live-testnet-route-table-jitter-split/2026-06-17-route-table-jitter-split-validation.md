# Route table split jitter validation

Date: 2026-06-17

Branch: `milestone2-benchmarking-monitoring`

Live target: `https://app.testnet.hyperspace.zone`

Validated changes:

- RTT jitter values are split into four sortable columns:
  `DZ RTT Jitter`, `Internet RTT Jitter`, `RTT Jitter Improvement`, and
  `RTT Jitter Saved`
- the directed city route column remains the first column
- `RTT Improvement`, `RTT Saved`, one-way columns, and loss remain visible
- the `All cities` filter remains compact and aligned with route status text

Validation:

- `npm run typecheck --workspace @hyperspace-zone/web`
- `npm run build --workspace @hyperspace-zone/web`
- `git diff --check`
- `HS_TEST_OUTPUT_DIR=m2-results/live-testnet-route-table-jitter-split npm run test:live:ui`

Smoke result:

- run id: `2026-06-17T05-18-50-561Z`
- status: `passed`
- console errors: none
- page errors: none

Primary screenshot:

- `2026-06-17T05-18-50-561Z-02-dashboard-gates.png`
