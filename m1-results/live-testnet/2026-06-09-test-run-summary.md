# Live Testnet Test Run Summary

Date: 2026-06-09 UTC.

Target deployment:

- Web/API: `https://app.testnet.hyperspace.zone`
- Public API base: `https://app.testnet.hyperspace.zone/api`
- DoubleZero network: `testnet`

## Cleanup Baseline

Before the final smoke runs, the public dashboard had no visible VPN configs.
Database counters showed no active visible sessions and no active/applied gate
assignments. Temporary configs created by these tests were revoked and deleted
at the end of each test.

Final post-run counters:

- Visible sessions: `0`
- Session phases: `revoked=124`, `failed=2`
- Gate assignment phases: `revoked=238`, `dead=2`

The two historical `failed` sessions and two `dead` assignments are not visible
to users and are not active gate state.

## Browser And API Smoke

Command:

```bash
HS_WEB_BASE=https://app.testnet.hyperspace.zone \
HS_API_BASE=https://app.testnet.hyperspace.zone/api \
HS_TEST_OUTPUT_DIR=m1-results/live-testnet \
HS_HEADLESS=true \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/snap/bin/chromium \
node scripts/testnet/live-ui-smoke.mjs
```

Result artifact:

- `m1-results/live-testnet/live-ui-smoke-2026-06-09T07-32-49-712Z.json`

Status: `passed`.

Covered:

- API health.
- Gate catalog with `Online`, `Schedulable`, `DoubleZero node`, and browser RTT
  columns.
- Register page and login page are separate and have no event log.
- Registration, logout, login.
- Create config Step 1 validation: egress is required.
- Create config Step 2 review: no browser RTT values shown in route overview.
- Config create, wait for `active`, raw `.conf` download contract check.
- UI Download button emits a `.conf` filename.
- Revoke and delete hide the config from dashboard.
- Browser console/page errors: none.

The smoke validates raw config shape but does not persist raw WireGuard config
files in test artifacts.

## WireGuard Policy Smoke

Command:

```bash
HS_API_BASE=https://app.testnet.hyperspace.zone/api \
HS_TEST_OUTPUT_DIR=m1-results/live-testnet \
HS_TESTNODE_SSH_KEY=/root/hyperspace/hyperspace_testnet_gatekeeper_20260526 \
node scripts/testnet/live-policy-smoke.mjs
```

Result artifact:

- `m1-results/live-testnet/live-policy-smoke-2026-06-09T07-29-12-234Z.json`

Status: `passed`.

Topology:

- Allowed source: `testnode-eu-sto-01.testnet.hyperspace.zone`
  (`212.147.245.233`)
- Denied source: `testnode-na-chi-01.testnet.hyperspace.zone`
  (`209.50.49.117`)
- Target: `testnode-eu-mad-01.testnet.hyperspace.zone` (`5.22.218.206`)
- Non-target: `testnode-ap-syd-01.testnet.hyperspace.zone`
  (`212.147.252.52`)
- Gates: `gate-eu-ams-01 -> gate-eu-lon-01`

Covered:

- Target allow: `10/10` packets received, RTT p50 `62.310 ms`.
- Non-target deny after client-side `AllowedIPs` widening: `0/10` packets
  received.
- Source deny from wrong public IP: `0/10` packets received.
- Custom public key with matching private key: `10/10` packets received, RTT
  p50 `62.432 ms`.
- Custom public key with non-matching private key: `0/10` packets received.

## Testnode Matrix

Command:

```bash
python3 scripts/testnodes/run_measurement_matrix.py \
  --mode all \
  --inventory m1-results/live-testnet/testnodes-inventory.json \
  --api-base https://app.testnet.hyperspace.zone/api \
  --ssh-key /root/hyperspace/hyperspace_testnet_gatekeeper_20260526 \
  --output-dir m1-results/live-testnet/matrix-2026-06-09 \
  --count 80 \
  --interval 0.04 \
  --timeout 2.0 \
  --active-timeout 120 \
  --revoke-timeout 120
```

Artifacts:

- `m1-results/live-testnet/matrix-2026-06-09/public.json`
- `m1-results/live-testnet/matrix-2026-06-09/gate-ping.json`
- `m1-results/live-testnet/matrix-2026-06-09/hyperspace.json`
- `m1-results/live-testnet/matrix-2026-06-09/comparison.md`

Status: `passed`.

Summary:

- Directed pairs measured: `20`
- Public packet loss: `0%` on every pair
- Hyperspace packet loss: `0%` on every pair
- Hyperspace faster by RTT p50: `6` pairs
- Public Internet faster by RTT p50: `14` pairs

Largest Hyperspace RTT improvements:

| Pair | Gates | Delta RTT |
| --- | --- | ---: |
| `eu-sto->ap-syd` | `gate-eu-ams-01 -> gate-ap-sin-01` | `+54.4 ms` |
| `ap-syd->eu-mad` | `gate-ap-sin-01 -> gate-eu-ams-01` | `+41.5 ms` |
| `na-chi->eu-mad` | `gate-na-nyc-01 -> gate-eu-ams-01` | `+21.6 ms` |
| `eu-mad->na-chi` | `gate-eu-ams-01 -> gate-na-nyc-01` | `+21.6 ms` |
| `eu-sto->na-chi` | `gate-eu-ams-01 -> gate-na-nyc-01` | `+20.8 ms` |

Observation: the current path heuristic selects ingress near the source and
egress near the destination by public ping to gates. It verifies route
functionality, but it is not always globally latency-optimal; for some AP/NA
and NA/NA pairs public Internet was faster.

## Local Repository Validation

Command:

```bash
npm run build && npm run typecheck && npm test --workspaces --if-present && \
  (cd apps/gate-agent && go test ./...)
```

Status: `passed`.

Notable unit coverage:

- `choosePath` regression for `gate_status` join and DoubleZero schedulability.
- Gate readiness requires host tools, `doublezero0`, BGP session up,
  matching DoubleZero environment, and matching tunnel source.
