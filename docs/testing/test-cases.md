# Test Cases

This document is the canonical test-case catalog for the DoubleZero WireGuard
VPN platform. It consolidates the acceptance scenarios discussed during
Milestone 1 work and keeps them independent from any specific private
Hyperspace development cluster.

Use these cases against a disposable validation account and temporary VPN
configs. Temporary configs should be revoked and deleted at the end of every
run.

## Test Environments

| Environment | Purpose |
| --- | --- |
| Local unit/build | Type safety, state-machine policies, route planning, gate readiness logic. |
| Public web/API | Self-service user flow, API contract, gate catalog visibility. |
| Validation testnodes | Real WireGuard traffic and source/target restriction tests. |
| Gate benchmark matrix | Continuous gate-to-gate public-vs-DoubleZero RTT, jitter, loss, and one-way estimates. |
| Measurement testnodes | Long-running user-path public-vs-Hyperspace RTT and one-way matrices. |
| Gate hosts | Reconciliation, job execution, WireGuard/nftables cleanup, DoubleZero readiness. |

## Command Taxonomy

Keep tests and measurements separate:

| Command | Purpose | Expected runtime | Runs connectivity matrix |
| --- | --- | --- | --- |
| `npm test` or `npm run test:unit` | Local workspace regression tests. | Short. | No |
| `npm run test:live:ui` | Browser/API smoke against a deployed HTTPS cluster. | Short to moderate. | No |
| `npm run test:live:policy` | Real WireGuard policy smoke on a small fixed set of validation clients. | Moderate. | No |
| Gate benchmark scheduler | Continuous `probe` jobs from the control-plane worker to gate agents. | Continuous. | Gate-to-gate only |
| `npm run measure:matrix -- ...` | Full directed public/Hyperspace RTT and one-way matrix. | Long. | Yes |
| `npm run measure:compare -- ...` | Compare already captured measurement JSON files. | Short. | Reads matrix outputs |

The `PERF-*` cases below are measurements, not regression tests. Run them on
demand for placement analysis, milestone evidence, or after topology changes.
Do not include them in routine `npm test` or live smoke runs.

## Core Health And Gate Readiness

| ID | Case | Steps | Expected | Coverage |
| --- | --- | --- | --- | --- |
| CP-001 | API health | `GET /api/health` from the public web host, or `GET /health` from a bare API host. | Returns `ok: true` and current server time. | `scripts/testnet/live-ui-smoke.mjs` |
| CP-002 | Public gate catalog | `GET /api/v1/public/gates`. | At least two gates are `ready=true`, `schedulable=true`; every gate has HTTPS `probeUrl`; every schedulable gate reports DoubleZero status. | `scripts/testnet/live-ui-smoke.mjs` |
| CP-003 | DoubleZero required for schedulability | Stop or disconnect DoubleZero on one gate, wait for heartbeat. | Gate remains `ready=true` while the agent reports fresh host state, but `schedulable=false`; DoubleZero node is absent/stale; scheduler does not select it. | Unit tests plus manual outage test |
| CP-004 | DoubleZero environment/source match | Run a gate with mismatched `doubleZeroEnv` or mismatched tunnel source. | Gate readiness remains tied to agent/host health, but schedulability is false and scheduler refuses it. | `packages/control-plane/src/resources/gates/readiness.test.ts` |
| CP-005 | Gate outage behavior | Stop gate software on one selected gate and request a config using it. | Provisioning does not hang forever; session moves to failed with a short error; Download/Revoke are disabled until appropriate. | Manual outage test |

## Public API And Artifact Contract

| ID | Case | Steps | Expected | Coverage |
| --- | --- | --- | --- | --- |
| API-001 | Register/login/me | Register a new user, log out, log in, call `/v1/public/auth/me`. | Auth token is issued; `me` returns the same email. | `scripts/testnet/live-ui-smoke.mjs` |
| API-002 | Target-restricted config lifecycle | Create `IpToIp` config with explicit ingress, explicit egress, target IP. Poll session list. | Session reaches `active`; selected path contains the chosen ingress/egress. | `scripts/testnet/live-ui-smoke.mjs` |
| API-003 | Raw WireGuard config download | Issue a download token, fetch `downloadConfigUrl`. | Response body is raw `.conf` text, not JSON; includes `[Interface]`, `[Peer]`, `AllowedIPs`, `Endpoint`. | `scripts/testnet/live-ui-smoke.mjs` |
| API-004 | JSON artifact compatibility | Fetch `downloadUrl`. | Response is JSON envelope with `payload.configText` for UI compatibility. | API smoke/manual |
| API-005 | Revoke/delete lifecycle | Revoke active config, poll until `revoked`, then delete. | Config disappears from the user's dashboard/session list. | `scripts/testnet/live-ui-smoke.mjs` |
| API-006 | Full tunnel config | Create config with destination restriction off. | Mode is `FullTunnel`; destination is `0.0.0.0/0`; review screen warns about SSH/RDP interruption. | UI smoke/manual |
| API-007 | Custom client public key | Create config with caller-provided WireGuard public key. | Downloaded config contains private-key placeholder; only matching private key can connect. | `scripts/testnet/live-policy-smoke.mjs` |

## Web UI

| ID | Case | Steps | Expected | Coverage |
| --- | --- | --- | --- | --- |
| UI-001 | Separate auth pages | Open `/register` and `/login`. | Register and login are separate pages; event console is not shown on auth pages. | `scripts/testnet/live-ui-smoke.mjs` |
| UI-002 | Dashboard layout | Log in with no configs. | Dashboard shows VPN configs area, Create config action, and Gates table as secondary information. | `scripts/testnet/live-ui-smoke.mjs` |
| UI-003 | Gates table columns | Open dashboard. | Columns include Name, City, Country, Public IPv4, Ready, Browser RTT, Schedulable, DoubleZero node. | `scripts/testnet/live-ui-smoke.mjs` |
| UI-004 | Browser RTT measurement | Click Measure browser RTT. | Rows update per gate as measurements finish; sort is low-to-high by default; measured rows keep stable row height. | UI smoke plus visual/manual |
| UI-005 | Create config Step 1 | Open `/create-config`. | Header says Step 1; ingress and egress selectors are aligned; no Ingress Auto/Egress Auto option exists. | `scripts/testnet/live-ui-smoke.mjs` |
| UI-006 | Explicit egress required | Choose ingress but leave egress empty and submit. | Inline validation says egress is required; config is not created. | `scripts/testnet/live-ui-smoke.mjs` |
| UI-007 | Target validation | Keep target restriction enabled with invalid/missing target. | Inline validation says target IPv4 is required; message is visible near the target mode help. | UI smoke/manual |
| UI-008 | Source restriction | Enable source restriction and use browser IP. | Browser IP is inserted only into Source IP, never into Target IP. | UI smoke/manual |
| UI-009 | Review screen | Submit valid Step 1. | Step 2 review shows route overview and policy; ingress/egress cards do not show browser RTT values. | `scripts/testnet/live-ui-smoke.mjs` |
| UI-010 | Full tunnel warning | Disable target restriction and review. | Warning explains SSH/RDP access may be interrupted and shows short up/sleep/curl/down instructions for Linux/macOS/Windows. | UI smoke/manual |
| UI-011 | Client key instructions | Enable custom public key. | Public key field becomes required; Linux/macOS/Windows generation scripts appear with syntax highlighting and copy button. | UI smoke/manual |
| UI-012 | WireGuard public key validation | Enter malformed key such as missing `=` padding. | UI rejects it as non-canonical WireGuard public key. | UI smoke/manual |
| UI-013 | Dashboard config table | After config create. | Table shows Created, Mode, Config, Source IP, Target IP, Ingress gate, Egress gate, Status, Actions. Source `Any` and target `Internet`/IP render compactly. | `scripts/testnet/live-ui-smoke.mjs` |
| UI-014 | Action buttons state | While requested/provisioning/failed/revoking/active. | Download and Revoke are enabled only when active; Delete revokes first when needed and then hides the config. | `scripts/testnet/live-ui-smoke.mjs` |
| UI-015 | Console cleanliness | Run happy path in Chromium/Brave. | No uncaught promise errors such as `AbortError: signal is aborted without reason`. | `scripts/testnet/live-ui-smoke.mjs` |
| UI-016 | Gate benchmark dashboard | Open dashboard after benchmark jobs have reported. | Dashboard shows `Gate benchmark matrix` with RTT comparison and one-way probe matrices. Cells show DoubleZero, public, delta, and loss values or `pending` before first samples. | Live dashboard/manual screenshot |

## WireGuard Traffic Policy

| ID | Case | Steps | Expected | Coverage |
| --- | --- | --- | --- | --- |
| WG-001 | Target allow | Start downloaded target-restricted config on a validation client and reach selected target IP. | Target is reachable through selected ingress/egress path. | `scripts/testnet/live-policy-smoke.mjs` |
| WG-002 | Non-target deny | With same config, widen client-side `AllowedIPs` and try a different non-target IP. | Non-target traffic is blocked/times out at the gate policy layer. | `scripts/testnet/live-policy-smoke.mjs` |
| WG-003 | Source allow | Create config restricted to validation client A public IP, start it on client A. | WireGuard handshake and target traffic work. | `scripts/testnet/live-policy-smoke.mjs` |
| WG-004 | Source deny | Start the same config from validation client B public IP. | WireGuard traffic is dropped by ingress source restriction. | `scripts/testnet/live-policy-smoke.mjs` |
| WG-005 | Custom private key ownership | Create config with public key generated on client A, but try to connect with a different private key. | Only the matching private key can complete WireGuard handshake. | `scripts/testnet/live-policy-smoke.mjs` |
| WG-006 | Additive config safety | Keep config A active, create config B with different gate pair. | Existing traffic through config A is not interrupted. | Testnode/manual |
| WG-007 | Revoke isolation | Keep config A active, revoke/delete config B. | Config A remains connected and traffic continues. | Testnode/manual |
| WG-008 | Cleanup after revoke | Revoke/delete config and inspect gates. | No stale WireGuard interfaces, nftables rules, leases, or managed handles remain for the revoked config. | Testnode/manual |

## Performance Measurements

| ID | Case | Steps | Expected | Coverage |
| --- | --- | --- | --- | --- |
| PERF-001 | Gate public-vs-DoubleZero matrix | Let the worker schedule gate `probe` jobs and call `/v1/public/benchmarks/gate-matrix`. | The API returns every directed gate pair with latest `public` and `doublezero` measurements once jobs complete. | `docs/runbooks/gate-benchmarking.md` |
| PERF-002 | Gate RTT/jitter/loss comparison | Inspect dashboard or API matrix. | Each completed cell shows DoubleZero RTT p50, public RTT p50, delta, jitter, and loss. Negative RTT delta means DoubleZero is faster. | Gate benchmark matrix |
| PERF-003 | Gate one-way estimates | Inspect dashboard one-way matrix. | Forward/reverse one-way estimates are present when chrony clock sync is good; RTT remains primary when clocks are noisy. | Gate benchmark matrix |
| PERF-004 | Public testnode RTT/one-way matrix | Run `npm run measure:matrix -- --mode public`. | `public.json` contains every directed testnode pair with low packet loss. | Measurement-only |
| PERF-005 | Hyperspace testnode RTT/one-way matrix | Run `npm run measure:matrix -- --mode hyperspace`. | `hyperspace.json` contains selected ingress/egress path per pair and successful probes. | Measurement-only |
| PERF-006 | Public vs Hyperspace comparison | Run `npm run measure:compare -- ...`. | Markdown report shows RTT p50 delta and forward/reverse one-way deltas sorted for review. | Measurement-only |
| PERF-007 | Gate selection heuristic | Inspect matrix path selection. | Ingress is chosen near source testnode; egress is chosen near destination testnode based on public ping ranking. | Testnode matrix |

## Regression Unit Tests

| ID | Case | Expected | Coverage |
| --- | --- | --- | --- |
| UNIT-001 | `choosePath` SQL joins gate status. | Scheduler never emits SQL referencing `gate_status` without joining it. | `packages/control-plane/src/planning/choose-path.test.ts` |
| UNIT-002 | Gate schedulability requires DoubleZero. | Missing `doublezero0`, down BGP session, env mismatch, or tunnel source mismatch keep gate ready when the agent/host is healthy, but make it unschedulable. | `packages/control-plane/src/resources/gates/readiness.test.ts` |
| UNIT-003 | Build/typecheck across workspaces. | Contracts, DB, control-plane, API, worker, web build and typecheck cleanly. | `npm run build && npm run typecheck` |

## Live Testnet Smoke

Run the browser/API smoke against the public testnet deployment:

```bash
npm install
npm run test:live:ui
```

Useful environment overrides:

```bash
HS_WEB_BASE=https://app.testnet.hyperspace.zone
HS_API_BASE=https://app.testnet.hyperspace.zone/api
HS_TEST_INGRESS=gate-eu-fra-01
HS_TEST_EGRESS=gate-eu-lon-01
HS_TEST_TARGET_IP=1.1.1.1
HS_TEST_OUTPUT_DIR=m1-results/live-testnet
HS_HEADLESS=true
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/snap/bin/chromium
```

The smoke creates a disposable account, creates one target-restricted config,
waits for `active`, validates raw `.conf` download, revokes the config, deletes
it from the dashboard, and writes screenshots plus a JSON result file.

Run the validation-client policy smoke after the UI smoke:

```bash
HS_API_BASE="$HS_PUBLIC_API_BASE" \
HS_TEST_OUTPUT_DIR=m1-results/live \
HS_TESTNODE_SSH_KEY="$HS_TESTNODE_SSH_KEY" \
HS_TEST_INGRESS="$HS_TEST_INGRESS" \
HS_TEST_EGRESS="$HS_TEST_EGRESS" \
HS_ALLOWED_SOURCE_HOST="$HS_ALLOWED_SOURCE_HOST" \
HS_ALLOWED_SOURCE_IP="$HS_ALLOWED_SOURCE_IP" \
HS_DENIED_SOURCE_HOST="$HS_DENIED_SOURCE_HOST" \
HS_DENIED_SOURCE_IP="$HS_DENIED_SOURCE_IP" \
HS_TARGET_HOST="$HS_TARGET_HOST" \
HS_TARGET_IP="$HS_TARGET_IP" \
HS_NON_TARGET_HOST="$HS_NON_TARGET_HOST" \
HS_NON_TARGET_IP="$HS_NON_TARGET_IP" \
npm run test:live:policy
```

The policy smoke creates temporary source-restricted configs, starts them with
`wg-quick` on validation testnodes, verifies target allow, non-target deny,
source deny, custom public key ownership, and then revokes/deletes the temporary
configs.

## Long-Running Measurements

Run the directed connectivity matrix only when measurement evidence is needed.
Use `docs/runbooks/long-running-measurement-matrix.md` for prerequisites and
commands.

This matrix creates many temporary configs, starts WireGuard repeatedly on
validation nodes, and probes every directed testnode pair. It is intentionally
excluded from `npm test`, `npm run test:live:ui`, and
`npm run test:live:policy`.
