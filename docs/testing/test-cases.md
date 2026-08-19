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
| Gate benchmark route table | Continuous gate-to-gate Internet-vs-DoubleZero RTT, jitter, loss, and one-way estimates. |
| Measurement testnodes | Long-running user-path Internet-vs-Hyperspace RTT and one-way matrices. |
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
| CP-001 | API health | `GET /api/health` from the public web host, or `GET /health` from a bare API host. | Returns `ok: true`, current server time, overall state, and component states. | `scripts/testnet/live-ui-smoke.mjs` |
| CP-002 | Public gate catalog | `GET /api/v1/public/gates`. | At least two gates are `ready=true`, `schedulable=true`; every gate has HTTPS `probeUrl`; every schedulable gate reports DoubleZero status. | `scripts/testnet/live-ui-smoke.mjs` |
| CP-003 | DoubleZero required for schedulability | Stop or disconnect DoubleZero on one gate, wait for heartbeat. | Gate remains `ready=true` while the agent reports fresh host state, but `schedulable=false`; DoubleZero node is absent/stale; scheduler does not select it. | Unit tests plus manual outage test |
| CP-004 | DoubleZero environment/source match | Run a gate with mismatched `doubleZeroEnv` or mismatched tunnel source. | Gate readiness remains tied to agent/host health, but schedulability is false and scheduler refuses it. | `packages/control-plane/src/resources/gates/readiness.test.ts` |
| CP-005 | Gate outage behavior | Stop gate software on one selected gate and request a config using it. | Provisioning does not hang forever; session moves to failed with a short error; Download/Revoke are disabled until appropriate. | Manual outage test |

## Public API And Artifact Contract

| ID | Case | Steps | Expected | Coverage |
| --- | --- | --- | --- | --- |
| API-001 | Register/login/me | Register a new user, log out, log in, call `/v1/public/auth/me`. | Auth token is issued; `me` returns the same email. | `scripts/testnet/live-ui-smoke.mjs` |
| API-002 | Target-restricted config lifecycle | Create `IpToIp` config with explicit ingress, explicit egress, target IP. Poll session list. | Session reaches `active`; selected path contains the chosen ingress/egress. | `scripts/testnet/live-policy-smoke.mjs` |
| API-003 | Raw WireGuard config download | Issue a download token, fetch `downloadConfigUrl`. | Response body is raw `.conf` text, not JSON; includes `[Interface]`, `[Peer]`, `AllowedIPs`, `Endpoint`. | `scripts/testnet/live-ui-smoke.mjs` |
| API-004 | JSON artifact compatibility | Fetch `downloadUrl`. | Response is JSON envelope with `payload.configText` for UI compatibility. | API smoke/manual |
| API-005 | Revoke/delete lifecycle | Revoke active config, poll until `revoked`, then delete. | Config disappears from the user's dashboard/session list. | `scripts/testnet/live-ui-smoke.mjs` |
| API-006 | Full tunnel config | Create config with destination restriction off. | Mode is `FullTunnel`; destination is `0.0.0.0/0`; review screen warns about SSH/RDP interruption. | UI smoke/manual |
| API-007 | Custom client public key | Create config with caller-provided WireGuard public key. | Downloaded config contains private-key placeholder; only matching private key can connect. | `scripts/testnet/live-policy-smoke.mjs` |

## Web UI

| ID | Case | Steps | Expected | Coverage |
| --- | --- | --- | --- | --- |
| UI-001 | Separate auth pages | Open `/register` and `/login`. | Register and login are separate pages; event console is not shown on auth pages. | `scripts/testnet/live-ui-smoke.mjs` |
| UI-002 | Dashboard layout | Log in with no configs. | Dashboard shows VPN configs, Create config action, and Gates as secondary information. Billing controls and benchmark route tables are not rendered on Dashboard. | `scripts/testnet/live-ui-smoke.mjs`, `scripts/testnet/milestone3-ui-smoke.mjs` |
| UI-003 | Gates table columns | Open dashboard. | Columns include Name, City, Country, Public IPv4, Ready, Browser RTT, Schedulable, DoubleZero node. | `scripts/testnet/live-ui-smoke.mjs` |
| UI-004 | Browser RTT measurement | Click Measure browser RTT. | Rows update per gate as measurements finish; sort is low-to-high by default; measured rows keep stable row height. | UI smoke plus visual/manual |
| UI-005 | One-choice config Step 1 | Open `/create-config`. | Egress is the only visible selector. Full tunnel, unrestricted source, generated client key, nearest ingress, config name, and routing policy defaults require no interaction. All non-egress controls are inside collapsed `Optional settings`. | `scripts/testnet/live-ui-smoke.mjs`, `scripts/testnet/milestone3-ui-smoke.mjs` |
| UI-006 | Explicit egress required | Choose ingress but leave egress empty and submit. | Inline validation says egress is required; config is not created. | `scripts/testnet/live-ui-smoke.mjs` |
| UI-007 | Target validation | Keep target restriction enabled with invalid/missing target. | Inline validation says target IPv4 is required; message is visible near the target mode help. | UI smoke/manual |
| UI-008 | Source restriction | Enable source restriction and use browser IP. | Browser IP is inserted only into Source IP, never into Target IP. | UI smoke/manual |
| UI-009 | Review screen | Submit valid Step 1. | Step 2 review shows route overview and policy; ingress/egress cards do not show browser RTT values. | `scripts/testnet/live-ui-smoke.mjs` |
| UI-010 | Full tunnel warning | Keep the default unrestricted destination and review. | Warning explains that enabling a full tunnel can interrupt SSH/RDP and recommends local-console or out-of-band access. | UI smoke/manual |
| UI-011 | Client key instructions | Enable custom public key. | Public key field becomes required; Linux/macOS/Windows generation scripts appear with syntax highlighting and copy button. | UI smoke/manual |
| UI-012 | WireGuard public key validation | Enter malformed key such as missing `=` padding. | UI rejects it as non-canonical WireGuard public key. | UI smoke/manual |
| UI-013 | Dashboard config table | After config create. | Table shows Created, Mode, Config, Source IP, Target IP, Ingress gate, Egress gate, Status, Actions. Source `Any` and target `Internet`/IP render compactly. | `scripts/testnet/live-ui-smoke.mjs` |
| UI-014 | Action buttons state | While requested/provisioning/failed/revoking/active. | Download and Revoke are enabled only when active; Delete revokes first when needed and then hides the config. | `scripts/testnet/live-ui-smoke.mjs` |
| UI-015 | Console cleanliness | Run happy path in Chromium/Brave. | No uncaught promise errors such as `AbortError: signal is aborted without reason`. | `scripts/testnet/live-ui-smoke.mjs` |
| UI-016 | Gate benchmark page | Open the `Benchmarks` navigation item after benchmark jobs have reported. | The page shows `Gate benchmark routes — RTT` and `Gate benchmark routes — One-Way` under `DZ vs Internet`, with sortable columns, City filter, freshness coverage, and green/yellow/pink legend. Rows use a directed `City1 → City2` route column and show RTT metrics separately from forward one-way metrics. | Live dashboard/manual screenshot |
| UI-017 | Billing page and header balance | Log in, inspect the header, then open `/billing`. | A compact available balance appears immediately before the identity. Billing is a primary navigation item and contains balance details, deposit address and QR, deposit history, usage, ledger, withdrawals, and support contact. Desktop and mobile layouts do not overflow the viewport. | `scripts/testnet/milestone3-ui-smoke.mjs`, `scripts/testnet/retail-billing-ui-e2e.mjs` |
| UI-018 | In-place config completion | Confirm Step 2 and wait for provisioning. | Browser remains on `/create-config`, shows an animated progress state, then replaces it with the WireGuard QR, Download config, and OK. Only OK returns to Dashboard. | `scripts/testnet/live-ui-smoke.mjs`, `scripts/testnet/milestone3-ui-smoke.mjs` |

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

## Basic Abuse Controls

| ID | Case | Steps | Expected | Coverage |
| --- | --- | --- | --- | --- |
| ABUSE-001 | Public API rate limit | Send more than `PUBLIC_RATE_LIMIT_READ_MAX` public read requests from the same client identity inside the configured window. | API returns `429` with `rate_limited`, `Retry-After`, and `X-RateLimit-*` headers. | `apps/control-plane-api/src/http/rate-limit.test.ts` |
| ABUSE-002 | Active config quota | Configure a low `SELF_SERVICE_MAX_ACTIVE_SESSIONS_PER_ACCOUNT`, then create one more non-terminal VPN config for the same account. | Create request is rejected with `session_quota_exceeded`; no session row is inserted; audit records `session_rejected`. | `packages/control-plane/src/application/sessions/create-session.scenario.test.ts` |
| ABUSE-003 | Create burst quota | Exceed `SELF_SERVICE_MAX_SESSION_CREATES_PER_WINDOW` inside `SELF_SERVICE_SESSION_CREATE_WINDOW_SECONDS`. | Create request is rejected with `session_create_rate_limited`; audit records `session_rejected`. | Manual/API smoke |
| ABUSE-004 | Public target guardrail | Try a self-service IP-to-IP config with a private, loopback, link-local, documentation, multicast, or broad destination CIDR. | API rejects the request with `destination_not_allowed` or `invalid_destination_cidr`. | `packages/control-plane/src/resources/sessions/abuse-controls.test.ts` |
| ABUSE-005 | Full-tunnel source policy | Try a full-tunnel config without source restriction, with a broad source CIDR, and with an invalid source CIDR. | Full tunnel without source restriction is allowed; private or broad source CIDRs are allowed when explicitly supplied; malformed source CIDRs are rejected with `invalid_source_cidr`. | `packages/control-plane/src/resources/sessions/abuse-controls.test.ts` |

## Monitoring And Alerting

| ID | Case | Steps | Expected | Coverage |
| --- | --- | --- | --- | --- |
| OBS-001 | API health ontology | `GET /api/health` from the public web host or `GET /health` from the API host. | Response includes `ok`, `state`, `service`, `components`, and current component states; database state is reported independently from metrics. | API live smoke/manual |
| OBS-002 | API metrics ontology | `GET /metrics` from the control-plane API host. | Prometheus text includes `hyperspace_api_http_requests_total`, `hyperspace_api_http_request_duration_seconds_bucket`, process gauges, and runtime metrics queue gauges. | API live smoke/manual |
| OBS-003 | Worker observability endpoint | `GET /health` and `GET /metrics` on `WORKER_OBSERVABILITY_HOST:WORKER_OBSERVABILITY_PORT`. | Health reports independent reconcile, scheduler, and snapshot loop components; metrics include worker loop counters/durations and control-plane DB snapshot gauges for gates, sessions, jobs, and benchmark results. | Worker live smoke/manual |
| OBS-004 | Prometheus alert rules | Run `promtool check config`, `promtool check rules`, and `promtool test rules`, then inspect `/prometheus/alerts`. | Rules load without errors and cover service-host down/disk/inode/RAM/OOM/CPU, PostgreSQL exporter/connections/transactions/autovacuum/growth/WAL/backup age, HTTP/TCP blackbox probes, TLS expiry, gate resources, business state, and benchmark routes. | `infra/observability/prometheus/rules/hyperspace-alerts.yml` |
| OBS-005 | Grafana dashboard | Open `https://observability.../d/hyperspace-control-plane`. | Dashboard renders separate Web, Control-plane Host, PostgreSQL, and Observability sections in addition to gate and control-plane business panels. | `infra/observability/grafana/dashboards/hyperspace-control-plane.json` |
| OBS-006 | Fast gate memory exhaustion alert | Keep a gate below either 10% or 128MiB available RAM for at least 30 seconds in an isolated test environment. | `HyperspaceGateMemoryCritical` becomes firing and remains firing for 10 minutes if node exporter disappears. | Prometheus rule test/manual isolated-host test |
| OBS-007 | Gate disk janitor metrics | Run `systemctl start hyperspace-disk-janitor.service` on a gate, then scrape node exporter. | `hyperspace_gate_disk_janitor_last_run_timestamp_seconds`, before/after disk gauges, last action, and runs counter are present through the `hyperspace-gate-node` job. | Gate live smoke/manual |
| OBS-008 | Gate runtime journal guard | Fill an isolated test gate's `/run` above 70%, run `hyperspace-disk-janitor.service`, and inspect the textfile metrics. | Runtime journals are vacuumed, `/run` before/after gauges are emitted, and Prometheus evaluates warning at 70% or critical at 85%. | Isolated-host test only |
| OBS-009 | Gate OOM detection | Increment `node_vmstat_oom_kill` in an isolated node-exporter fixture and evaluate the rules. | `HyperspaceGateOOMKill` becomes critical without an additional `for` delay and remains firing for 30 minutes. | Prometheus rule test |
| OBS-010 | Benchmark failure aggregation | Persist one failed cycle and then two consecutive failed cycles for several routes from one source gate. | One cycle is retained without an alert; after the second cycle Prometheus emits one gate-level alert whose value is the number of confirmed failed route/transports. | Worker metrics and Prometheus rule test |
| OBS-011 | DoubleZero BGP flap audit | Report a gate heartbeat with a changed `doubleZero.tunnelStatus`, then report the same status again. | Exactly one `gate_doublezero_tunnel_status_changed` audit event records the transition; an unchanged heartbeat does not duplicate it. | `packages/control-plane/src/resources/gates/repository.test.ts` |
| OBS-012 | Snapshot isolation | Block a reconcile task while the worker is running. | Snapshot collection continues on its independent interval; if no snapshot completes for more than one minute, `HyperspaceControlPlaneSnapshotStale` becomes warning. | `apps/control-plane-worker/src/runners/worker-runner.test.ts` and Prometheus rule test |
| OBS-013 | Gate firewall persistence | Provision a gate with observability and benchmark peer IPv4s, reboot it, then run `hyperspace-gate-firewall --check`. | The systemd unit is enabled and the scoped TCP/9100 and UDP/19192 UFW rules remain present after boot. | `scripts/gates/firewall.test.mjs` and gate live smoke |
| OBS-014 | NTP scheduler history scaling | Populate historical probe jobs and inspect the NTP scheduling SQL and database indexes. | Scheduling materializes only active/recent NTP gate IDs and uses partial indexes instead of repeatedly scanning all historical jobs. | `packages/control-plane/src/resources/benchmarks/repository.test.ts` and migration `0031_ntp_scheduler_indexes.sql` |

## Performance Measurements

| ID | Case | Steps | Expected | Coverage |
| --- | --- | --- | --- | --- |
| PERF-001 | Gate Internet-vs-DoubleZero measurements | Let the worker schedule gate `probe` jobs and call `/v1/public/benchmarks/gate-matrix`. | The API returns every directed gate pair with latest Internet measurements and DoubleZero measurements when the gates report different DZ metros. Same-DZ-metro routes are public-only and expose `doublezeroApplicability.reason="same_doublezero_metro"`. | `docs/runbooks/gate-benchmarking.md` |
| PERF-002 | Gate RTT/jitter/loss comparison | Inspect the `Gate benchmark routes — RTT` table or API response. | Each completed row shows DoubleZero RTT p50, Internet RTT p50, RTT improvement, RTT saved, DoubleZero RTT jitter, Internet RTT jitter, RTT jitter improvement, RTT jitter saved, loss with DoubleZero and Internet values, ingress gate ↔ DZ RTT, and egress gate ↔ DZ RTT. The ingress/egress columns come from each gate heartbeat's local DoubleZero edge RTT. Positive improvement means DoubleZero is faster. | Gate benchmark route table |
| PERF-003 | Gate one-way estimates | Inspect the `Gate benchmark routes — One-Way` table. | Directed forward one-way estimates are present in separate `DZ One-Way`, `Internet One-Way`, `One-Way Improvement`, and `One-Way Saved` columns when chrony clock sync is good; RTT remains primary when clocks are noisy. | Gate benchmark route table |
| PERF-004 | Public testnode RTT/one-way matrix | Run `npm run measure:matrix -- --mode public`. | `public.json` contains every directed testnode pair with low packet loss. | Measurement-only |
| PERF-005 | Hyperspace testnode RTT/one-way matrix | Run `npm run measure:matrix -- --mode hyperspace`. | `hyperspace.json` contains selected ingress/egress path per pair and successful probes. | Measurement-only |
| PERF-006 | Same DoubleZero metro benchmark eligibility | Use two enabled gates with the same non-empty `gate_status.doublezero_status.metro`, wait for scheduling, and inspect the job payload, public matrix, UI, and worker metrics. | The job contains only the `public` transport; API returns `doublezeroApplicability.reason="same_doublezero_metro"`; UI displays `N/A — same DZ metro`; no DoubleZero failed/stale Prometheus series is emitted for the pair. If either metro is empty, both transports remain enabled. | `packages/control-plane/src/resources/benchmarks/repository.test.ts` |
| PERF-006 | Internet vs Hyperspace comparison | Run `npm run measure:compare -- ...`. | Markdown report shows RTT p50 delta and forward/reverse one-way deltas sorted for review. | Measurement-only |
| PERF-007 | Gate selection heuristic | Inspect matrix path selection. | Ingress is chosen near source testnode; egress is chosen near destination testnode based on public ping ranking. | Testnode matrix |

## Regression Unit Tests

| ID | Case | Expected | Coverage |
| --- | --- | --- | --- |
| UNIT-001 | `choosePath` SQL joins gate status. | Scheduler never emits SQL referencing `gate_status` without joining it. | `packages/control-plane/src/planning/choose-path.test.ts` |
| UNIT-002 | Gate schedulability requires DoubleZero. | Missing `doublezero0`, down BGP session, env mismatch, or tunnel source mismatch keep gate ready when the agent/host is healthy, but make it unschedulable. | `packages/control-plane/src/resources/gates/readiness.test.ts` |
| UNIT-003 | Milestone 3 identity, OTP, and Solana wallet primitives. | Password login requires verified email; Google linking prefers provider `sub`, safely claims unverified password accounts, OTP uses HMAC verification, and custodial Solana seeds are random and encrypted. | `packages/control-plane/src/application/auth/*.test.ts` |
| UNIT-004 | Finalized Solana deposit verification. | RPC status, configured mint, recipient owner, and positive exact base-unit delta must match before credit; one signature can produce only one receipt and ledger entry. | `packages/control-plane/src/application/billing/solana-rpc-verifier.test.ts`, `scripts/testnet/milestone3-billing-db-e2e.mjs` |
| UNIT-005 | Censorship-resistant route policy. | `choosePath` passes normalized excluded countries, cities, and preferred egress regions to schedulable gate selection. | `packages/control-plane/src/planning/choose-path.test.ts` |
| UNIT-006 | Metering payload validation. | Missing byte or cost fields are rejected instead of silently becoming zero-cost usage. | `apps/control-plane-worker/src/loops/doublezero-metering-loop.test.ts` |
| UNIT-007 | Build/typecheck across workspaces. | Contracts, DB, control-plane, API, worker, web build and typecheck cleanly. | `npm run build && npm run typecheck` |

## Milestone 3 UI Smoke

Run the offline Chromium smoke for the self-service account console:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/snap/bin/chromium npm run test:milestone3:ui
```

The smoke mocks the public API, registers with a password, completes email
verification, verifies the account balance, permanent deposit address, QR and
finalized transaction history, and proves fixed-amount and wallet-link controls
are absent. It then verifies that only egress is visible and required, watches
the same confirmation route transition through provisioning to QR/download,
acknowledges the result with OK, and checks the active-config QR and helper.

## Resend OTP E2E

Resend assigns one receiving domain where every local part is accepted. The
test uses unique addresses under `vutcenoi.resend.app`, polls the Receiving
API for the delivered message, retrieves its body, extracts the OTP, and then
verifies the resulting Hyperspace session.

```bash
cd /root/hyperspace/2z-wireguard-vpn
npm run test:live:email
```

Optional overrides:

```bash
HS_API_BASE=https://app.testnet.hyperspace.zone/api
RESEND_RECEIVING_DOMAIN=vutcenoi.resend.app
RESEND_RECEIVING_API_KEY=re_full_access_key
RESEND_RECEIVING_TIMEOUT_MS=90000
```

Keep the runtime `RESEND_API_KEY` restricted to Sending access. Create a
separate `RESEND_RECEIVING_API_KEY` with Full access for test automation because
Resend Receiving API calls are rejected for send-only keys. The
test covers password registration followed by OTP verification and password
login, repeated OTP login on the same password account, and OTP-first account
creation followed by another OTP login. It asserts stable account IDs across
all repeated methods. See the [Resend Receiving documentation](https://resend.com/docs/dashboard/receiving/introduction)
and [Receiving API](https://resend.com/docs/api-reference/emails/list-received-emails).

Run the identity-order integration scenarios against a disposable test database
or the testnet database. The script uses unique addresses, a fake Google
provider at the fetch boundary, and removes every account it creates:

```bash
set -a
. /etc/hyperspace/control-plane-api.env
set +a
cd /opt/2z-wireguard-vpn
npm run test:live:identity-db
```

This verifies Google-first then OTP, verified password then Google with the
password preserved, and Google claiming an unverified password account with
the old password and sessions revoked.

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
