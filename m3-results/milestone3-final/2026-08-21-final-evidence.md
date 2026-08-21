# Milestone 3 Final Evidence

Date: 2026-08-21

Production: <https://app.hyperspace.zone>

Source branch: `main`

Production release under live acceptance: `15fc873`

Immutable acceptance snapshot: `doublezero-grant-milestone-3`

## Acceptance Summary

Milestone 3 requires a live broader mainnet footprint, documented deployment
automation, billing alignment and Hyperspace markup, self-service social login,
Solana balance top-up and VPN config management, a smoother WireGuard user
experience, and configurable geographic routing exclusions.

The production deployment satisfies the user-facing and operational acceptance
criteria. The software integration boundary for DoubleZero cost records is
implemented and tested. Current IBRL connections have not supplied billable
upstream cost events, so the report distinguishes that zero-event upstream
state from the independently live customer SOL billing flow.

| Milestone item | Production result |
| --- | --- |
| Broader mainnet footprint | 29 ready and schedulable gates across 28 unique cities/PoPs, 16 countries and 29 DoubleZero devices |
| Deployment automation | Idempotent bootstrap and validation, immutable agent artifacts, dry-run, managed canary/wave rollout and automatic rollback |
| Billing alignment and markup | Replay-safe DoubleZero cost-event adapter and 15% markup path are tested; native SOL deposits and per-config payments are live |
| Self-service application | Google OAuth, email OTP, account-scoped Solana wallets, deposit history and config lifecycle are live |
| WireGuard UX | Egress is the only required selection; QR, raw `.conf` and OS connection helpers are provided |
| Routing exclusions | Arbitrary countries and cities can be excluded; Germany was tested as ordinary policy data in production |

## Mainnet Footprint And Benchmarks

The production catalog contains 30 visible records. One non-schedulable record
is excluded from placement. All 29 schedulable gates reported fresh agent
state, `BGP Session Up`, an activated DoubleZero device and route state
`ready` when the inventory was captured.

The complete directed benchmark matrix contains `29 x 28 = 812` routes:

- public transport succeeded on 812/812 routes;
- DoubleZero transport succeeded on 802/802 applicable routes;
- 10 same-metro routes were correctly classified as not applicable;
- DoubleZero was faster on 649/802 comparable routes;
- median RTT saving was 7.549 ms;
- maximum observed RTT saving was 360.727 ms.

See `production-gate-inventory-summary.json`,
`production-managed-rollout-inventory.json`,
`production-gate-benchmark-summary.json`, and the dashboard and Grafana
screenshots. The managed-rollout inventory contains only public gate metadata
and can be passed directly to `control-plane-rollout.mjs --inventory` with wave
`milestone3-final`; runtime authentication remains external to Git.

## Deployment Automation

The deployment toolchain is documented in `scripts/gates/README.md` and
`docs/runbooks/deployment.md`. It provides:

- idempotent Ubuntu host bootstrap and hardening;
- DoubleZero, WireGuard, chrony, firewall and observability setup;
- immutable gate-agent builds with embedded Git revision, build time and
  artifact SHA-256;
- binary self-tests before activation;
- dry-run and canary-first wave ordering;
- control-plane-managed artifact delivery without fleet SSH credentials;
- heartbeat verification of the exact installed revision and SHA;
- automatic rollback when activation or verification fails.

On 2026-08-21, `gate-eu-sxb-41` was selected as a production canary because it
had zero active assignments. The managed rollout installed gate-agent `0.4.0`
from application revision `15fc873`, deployment
`eee703a4-68cf-4070-8c09-af85a44ed74b` reached `succeeded`, and the gate then
reported:

- matching artifact SHA-256;
- fresh heartbeat;
- ready and schedulable state;
- `BGP Session Up`;
- DoubleZero route state `ready`;
- HTTP probe status 204.

The exact sanitized dry-run, execute result and post-rollout state are included
as `production-canary-rollout-*.json`. A separate 29-gate inventory dry-run
proves that the same artifact and canary ordering can address the complete
production fleet.

## Billing Flow

The current production settlement asset is native SOL on Solana mainnet. Each
account receives a randomly generated custodial wallet whose seed is encrypted
at rest. The active flow is:

1. The user sends any positive SOL amount to the permanent account deposit
   address or scans its QR code.
2. The worker discovers finalized inbound transactions through a historical
   RPC path.
3. A transaction signature can create only one receipt and ledger credit.
4. The UI displays the finalized on-chain balance and deposit history.
5. Creating a VPN config transfers `100000` lamports (`0.0001 SOL`) plus the
   Solana network fee from the account wallet to the production treasury.
6. A stable payment request ID and pre-recorded signed transaction make retries
   idempotent.
7. The config is provisioned only after the payment reaches confirmed/finalized
   state.

Production acceptance contains two independently finalized deposits totalling
10,500,000 lamports. Repeated scanning did not create duplicate receipts or
ledger entries. The routing-exclusion acceptance then confirmed a separate
100,000-lamport config payment before provisioning the VPN config.

For DoubleZero wholesale alignment, the worker contains a normalized importer
for upstream usage/cost records, rejects malformed records, deduplicates source
events, applies `1500` basis points of Hyperspace markup with deterministic
rounding, and writes auditable ledger entries. The focused TAP evidence covers
normalization and markup. Current IBRL connections have supplied no billable
upstream events, so no provider-origin deduction is claimed in this report.

Implementation and operations are documented in
`docs/architecture/retail-billing.md` and
`docs/runbooks/milestone3-billing-and-wallets.md`.

## Authentication And Self-Service

Production authentication supports:

- Google OAuth with the production callback URL;
- one-time email codes delivered through Resend;
- password compatibility and secure identity linking.

The automated production OTP acceptance passed both password-then-OTP and
OTP-then-OTP flows. The Google authorization redirect reached
`accounts.google.com` with the production callback URL, and a separate manual
production login left one verified Google identity linked to the same account
as its email identity.

The production Chromium acceptance covered Billing, dashboard, benchmarks,
egress-only config creation, SOL payment, activation, raw config validation,
QR, helper/config downloads, revoke and delete with no browser, page or HTTP
errors.

## WireGuard Data Plane

Four temporary external testnodes exercised real production WireGuard configs:

- a 29-route cycle covered every schedulable gate once as ingress and once as
  egress;
- 29/29 route probes passed;
- the policy matrix passed 32/32 checks;
- restricted and unrestricted source modes passed;
- restricted and unrestricted destination modes passed;
- generated and user-provided public keys passed;
- a wrong private key was rejected.

All acceptance configs were revoked and deleted. All four temporary testnodes
were deleted and post-delete provider lookups returned 404.

## Geographic Exclusions

The production UI populated country and city exclusions from the live gate
catalog. Selecting Germany kept the section expanded and removed German gates
from ingress and egress candidates. The paid live config persisted:

```json
{
  "excludeCountries": ["Germany"],
  "excludeCities": [],
  "preferredRegions": [],
  "reason": "user-routing-policy"
}
```

The scheduler selected Stockholm, Sweden as ingress and Oslo, Norway as
egress. The config became active, produced a valid WireGuard artifact and was
then revoked and hidden. Exclusions are enforced for Hyperspace ingress and
egress gates. DoubleZero does not expose opaque internal transit hops, so the
product does not claim to filter those unobservable hops.

## Verification Commands

The tagged source tree is verified from a clean clone with:

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run test:gate-provisioning
npm run test:control-plane-deployment
npm run test:billing-operations
cd apps/gate-agent && go test ./...
```

Prometheus configuration and rule tests are validated separately with
`promtool`. Test results are summarized in `acceptance-test-summary.json`.

## Evidence Index

- `production-gate-inventory-summary.json`
- `production-managed-rollout-inventory.json`
- `production-managed-inventory-dry-run.json`
- `production-gate-benchmark-summary.json`
- `production-wireguard-gate-cycle-summary.json`
- `production-wireguard-policy-summary.json`
- `production-canary-rollout-dry-run.json`
- `production-canary-rollout-execute.json`
- `production-canary-post-rollout.json`
- `production-sol-billing-summary.json`
- `billing-alignment-tests.tap`
- `production-email-otp-summary.json`
- `production-google-oauth-start-summary.json`
- `production-google-oauth-summary.json`
- `production-routing-exclusion-summary.json`
- `acceptance-test-summary.json`
- `screenshots/`
- `SHA256SUMS`

No API keys, private keys, passwords, authentication tokens, private RPC URLs,
raw WireGuard configurations or temporary provider credentials are included in
this evidence bundle.
