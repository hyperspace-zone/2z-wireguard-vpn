# Benchmark edge RTT validation

Date: 2026-06-17
Environment: `https://app.testnet.hyperspace.zone/benchmarks`
Branch: `milestone2-benchmarking-monitoring`

## Scope

- Moved `Ingress gate -> DZ RTT` and `Egress gate -> DZ RTT` to the end of the
  RTT benchmark table.
- Changed these columns from full-route one-way timestamp legs to local
  gate-to-DoubleZero edge RTT reported by gate-agent heartbeat.
- Deployed updated `hyperspace-gate-agent` to all five testnet gates.

## Live values

Current `/api/v1/public/benchmarks/gate-matrix` for
`gate-ap-sin-01 -> gate-na-nyc-01`:

- DZ RTT: `221.819 ms`
- Internet RTT: `237.13 ms`
- Ingress gate -> DZ RTT: `0.556 ms` to `180.87.102.98`
- Egress gate -> DZ RTT: `1.731 ms` to `64.86.249.22`

## Verification

```bash
/usr/local/go/bin/go test ./...
npm run build
npm run typecheck
npm test
HS_TEST_OUTPUT_DIR=m2-results/live-testnet-benchmark-edge-rtt-final npm run test:live:ui
```

Live UI smoke status: `passed`

Artifacts:

- `2026-06-17T06-42-57-478Z-03-benchmarks.png`
- `live-ui-smoke-2026-06-17T06-42-57-478Z.json`
