# Benchmark saved sign and colors validation

Date: 2026-06-17

Branch: `milestone2-benchmarking-monitoring`

Live target: `https://app.testnet.hyperspace.zone/benchmarks`

Validated changes:

- saved metrics now use Lake-style signs:
  - DZ improvement renders as negative saved time, for example `-2.5ms`
  - Internet-faster degradation renders as positive saved time, for example `+14.3ms`
- the same sign convention is used in the RTT table and the One-Way table
- improvement badge and legend background colors use:
  - green: `#DBFCE7`
  - yellow: `#FEF9C2`
  - pink: `#FFE2E2`

Validation:

- `npm run typecheck --workspace @hyperspace-zone/web`
- `npm run build --workspace @hyperspace-zone/web`
- `git diff --check`
- `HS_TEST_OUTPUT_DIR=m2-results/live-testnet-benchmark-saved-sign-colors npm run test:live:ui`

Smoke result:

- run id: `2026-06-17T06-08-53-552Z`
- status: `passed`
- console errors: none
- page errors: none

Primary screenshot:

- `2026-06-17T06-08-53-552Z-03-benchmarks.png`
