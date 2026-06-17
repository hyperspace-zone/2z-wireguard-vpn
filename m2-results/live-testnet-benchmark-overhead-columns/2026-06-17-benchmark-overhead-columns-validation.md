# Benchmark overhead columns validation

Date: 2026-06-17
Environment: `https://app.testnet.hyperspace.zone/benchmarks`
Branch: `milestone2-benchmarking-monitoring`

## Scope

- Removed the `Loss` column from the RTT route table.
- Added sortable `Ingress gate -> DZ RTT` and `Egress gate -> DZ RTT` columns.
- Kept RTT jitter values split across `DZ RTT Jitter`, `Internet RTT Jitter`,
  `RTT Jitter Improvement`, and `RTT Jitter Saved`.
- Preserved separate one-way table and Lake-style saved signs/colors.

The ingress/egress DZ RTT values are derived from the latest DZ probe
forward/reverse timestamp legs because gate-agent does not currently publish a
separate current-device RTT field.

## Verification

```bash
npm run build
npm run typecheck
npm test
HS_TEST_OUTPUT_DIR=m2-results/live-testnet-benchmark-overhead-columns npm run test:live:ui
```

Live UI smoke status: `passed`

Artifacts:

- `2026-06-17T06-24-02-814Z-03-benchmarks.png`
- `live-ui-smoke-2026-06-17T06-24-02-814Z.json`
