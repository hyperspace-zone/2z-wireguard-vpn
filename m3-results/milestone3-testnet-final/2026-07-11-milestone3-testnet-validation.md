# Milestone 3 Testnet Validation

Date: 2026-07-11

Branch: `milestone3-mainnet-scaleout`

Environment:

- Web: `https://app.testnet.hyperspace.zone`
- API: `https://control-plane.testnet.hyperspace.zone`
- Observability: `https://observability.testnet.hyperspace.zone`
- Schedulable testnet gates during the run: 5

## Automated Results

- Workspace unit tests: passed.
- Workspace TypeScript checks: passed.
- PostgreSQL identity linking: Google-first/OTP, verified-password/Google, and
  secure claim of an unverified password account passed.
- PostgreSQL billing: encrypted custodial wallet, finalized RPC fixture,
  `2500` minor-unit credit, and transaction-signature replay protection passed.
- Prometheus: config and 19 rules passed `promtool`; billing rules were loaded.
- Live Chromium flow: passed with no console or page errors.
- Mobile layout: document width remained within a 390px viewport; wide gate
  data remained inside its own horizontal scroll container.

The live flow covered password login, automatic account custodial Solana
wallet, Solana Pay intent, browser RTT, benchmark page, generic preferred
region and country/city exclusions, two-gate config activation, raw WireGuard
config validation, QR generation, OS helper download, normal download, revoke,
delete, and cleanup.

Result JSON:

- `live-ui-smoke-2026-07-11T15-57-00-223Z.json`

Screenshots:

- `2026-07-11T15-57-00-223Z-02-dashboard-gates.png`
- `2026-07-11T15-57-00-223Z-02-dashboard-mobile.png`
- `2026-07-11T15-57-00-223Z-03-benchmarks.png`
- `2026-07-11T15-57-00-223Z-03-review.png`
- `2026-07-11T15-57-00-223Z-04-active.png`
- `2026-07-11T15-57-00-223Z-05-deleted.png`

## External Inputs Still Required

- Resend OTP delivery works, but fully automated inbound-code retrieval needs a
  separate Full-access `RESEND_RECEIVING_API_KEY`; the current key is send-only
  and receives `401` from `/emails/receiving`.
- Google OAuth was verified manually in testnet. Fully unattended Google login
  is intentionally not attempted because Google requires an interactive user
  session.
- The normalized, replay-safe DoubleZero metering importer, markup, ledger,
  cursor, metrics, and alerts are deployed. Enabling its periodic feed awaits
  DoubleZero's final Hyperspace tenant metering endpoint/payload and bearer
  credentials.
- The final expansion from 14 mainnet gates toward 29 PoPs is explicitly
  deferred to the provisioning wave requested after the software work.
