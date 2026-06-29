# Milestone 3 Development Plan

Branch: `milestone3-mainnet-scaleout`
Start point: `doublezero-grant-milestone-2`

## Goal

Milestone 3 is the mainnet rollout and scale-out milestone:

- expand the deployment toward a broader footprint, target up to about 29 PoPs,
- add deployment automation for the broader footprint,
- consume DoubleZero metering or billing outputs and apply Hyperspace markup,
- extend the self-service web interface with social login onboarding,
  Solana wallet support, config management, and balance top-up,
- smooth WireGuard connection UX,
- support routing constraints such as excluding Germany for censorship-resistant
  routing.

Acceptance requires mainnet to be live, deployment automation to be documented,
the billing flow to be documented, and the self-service web interface to support
social sign-in, Solana wallet support, issued config management, and balance
top-up for usage across active VPN configs.

## Current Baseline

Milestone 2 delivered:

- 5 enabled testnet gates,
- 14 enabled mainnet gates,
- public Benchmarks page with Internet vs DoubleZero RTT, jitter, loss, and
  one-way views,
- control-plane initiated gate-to-gate benchmark jobs,
- Prometheus, Grafana, Alertmanager, and Telegram alert routing,
- basic abuse controls for public API and self-service session creation,
- gate lifecycle support for enabled, maintenance, disabled, and temporary
  removal states.

Milestone 3 should build on that state rather than replace it.

## Workstream 1: Mainnet Footprint Scale-Out

Target outcome: expand mainnet from the current 14 enabled gates toward about 29
PoPs without making operations manual and fragile.

Tasks:

1. Define the target PoP inventory.
   - Maintain a single declarative inventory file for intended mainnet gates.
   - Track city, country, provider, public IPv4, probe host, DoubleZero
     environment, desired state, and rollout wave.
   - Keep planned and access-pass-pending gates visible but unschedulable.

2. Add gate admission states.
   - `planned`: catalog record exists, no traffic or benchmarks.
   - `provisioning`: host bootstrap is running.
   - `access_pass_pending`: gate software can run, DoubleZero access is not
     approved yet.
   - `maintenance`: host is intentionally down or excluded.
   - `enabled`: schedulable when health and DoubleZero readiness pass.

3. Build wave-based rollout checks.
   - Add gates in small waves.
   - Require BGP up, agent heartbeat, probe listeners ready, browser probe,
     chrony clock error, and benchmark samples before moving a gate to enabled.
   - Automatically suppress benchmark and gate alerts for planned, disabled, and
     maintenance gates.

4. Update dashboards.
   - Add footprint count by state.
   - Add per-region or per-continent gate count.
   - Add alert for insufficient enabled gates only after excluding planned and
     maintenance gates.

Deliverables:

- updated gate inventory format,
- scale-out runbook,
- 29-PoP candidate list with rollout status,
- screenshots showing the expanded mainnet footprint.

## Workstream 2: Deployment Automation

Target outcome: a new gate can be provisioned from a clean Ubuntu host with an
idempotent command sequence and a documented checklist.

Tasks:

1. Convert manual host setup into automation.
   - HWE kernel installation.
   - OS package updates.
   - `fwupd` disablement.
   - chrony installation and NTP source tuning.
   - DoubleZero repository setup.
   - `doublezero` package installation.
   - `doublezerod` systemd drop-in with passive route-liveness traffic tuning.
   - gate-agent binary installation and systemd service.
   - Caddy probe setup.
   - firewall rules.

2. Make gate bootstrap idempotent.
   - Re-running automation must not overwrite DoubleZero identity keys.
   - Re-running automation must not overwrite WireGuard server keys unless
     explicitly requested.
   - All generated secrets should have predictable paths and permissions.

3. Add deployment commands.
   - `scripts/gates/bootstrap-host`
   - `scripts/gates/deploy-agent`
   - `scripts/gates/validate-host`
   - `scripts/gates/rollout-wave`

4. Add validation outputs.
   - JSON summary per host.
   - Human-readable table for operators.
   - Exit codes suitable for CI or a deployment orchestrator.

5. Document rollback.
   - Stop scheduling a gate.
   - Move gate to maintenance.
   - Roll back gate-agent.
   - Roll back `doublezerod` drop-ins.

Deliverables:

- documented deployment automation,
- idempotent gate bootstrap scripts,
- validation evidence for at least one new rollout wave.

## Workstream 3: Billing Alignment

Target outcome: Hyperspace can ingest DoubleZero metering or billing outputs,
apply markup, and expose user-facing balances and usage.

Tasks:

1. Define billing domain model.
   - `billing_accounts`
   - `wallet_links`
   - `topups`
   - `usage_events`
   - `metering_imports`
   - `rated_usage`
   - `balance_ledger_entries`
   - `pricing_plans`

2. Build a DoubleZero metering adapter.
   - Store raw imports unchanged for auditability.
   - Normalize to usage events with source, destination, time window, bytes,
     DoubleZero cost basis, and correlation metadata.
   - Make imports idempotent and replayable.

3. Add Hyperspace markup.
   - Configurable markup policy.
   - Versioned pricing plan snapshots.
   - Rated usage events linked to raw metering rows.
   - Reconciliation report: raw DoubleZero cost, Hyperspace markup, user charge.

4. Add balance ledger.
   - Immutable credit and debit entries.
   - Prevent negative balance unless explicitly allowed.
   - Suspend or prevent new configs when balance is insufficient.
   - Emit alerts when metering import is stale or reconciliation fails.

5. Add billing APIs.
   - Current balance.
   - Usage history.
   - Top-up initiation.
   - Top-up status.
   - Invoice or statement export.

Deliverables:

- billing flow documentation,
- metering import schema,
- markup and ledger implementation,
- reconciliation tests,
- user-facing balance and usage API.

## Workstream 4: Social Login And Solana Wallet Support

Target outcome: users can onboard with a social login provider and link a Solana
wallet for identity and payments.

Tasks:

1. Add OAuth social login.
   - Start with one provider, preferably Google or GitHub.
   - Store provider subject, email, display name, and verification status.
   - Keep existing email/password or local auth path as a fallback if still
     needed for operators.

2. Add account linking.
   - Multiple auth methods can map to one user account.
   - Prevent accidental account takeover when provider emails overlap.
   - Add audit events for login, link, unlink, and failed link attempts.

3. Add Solana wallet support.
   - Browser wallet connect flow.
   - Sign-in/link message with nonce and expiry.
   - Verify wallet signature server-side.
   - Store wallet public key and link it to the billing account.

4. Add session UX.
   - Clear onboarding flow for first-time users.
   - Account page listing social identities and linked wallet.
   - Security event history.

Deliverables:

- OAuth login flow,
- Solana wallet link and signature verification,
- tests for account linking and replay prevention,
- screenshots of onboarding and account settings.

## Workstream 5: Self-Service Config Management And Top-Up UI

Target outcome: the web app becomes a usage-oriented account console, not only a
config issuer.

Tasks:

1. Config management.
   - List issued configs with status, route, mode, created time, last activity,
     and usage.
   - Download config again while access token is valid or generate a new
     short-lived download token.
   - Revoke config.
   - Delete or hide revoked configs.
   - Show assignment and provisioning state clearly.

2. Top-up and balance.
   - Balance card.
   - Top-up amount selection.
   - Top-up method selection.
   - Top-up status after payment confirmation.
   - Usage across active VPN configs.

3. Billing guardrails.
   - Warn when balance is low.
   - Block new config creation when balance is insufficient.
   - Show why a config is blocked or suspended.

4. Admin support.
   - Admin view for account balance, usage, and metering reconciliation.
   - Manual adjustment with audit log.

Deliverables:

- updated self-service dashboard,
- config management UI,
- top-up UI,
- usage and balance views,
- screenshots for acceptance.

## Workstream 6: WireGuard UX Smoothing

Target outcome: reduce the number of manual steps required for a user to connect.

Tasks:

1. Improve config delivery.
   - QR code for mobile WireGuard apps.
   - OS-specific setup hints.
   - Named config files with route and city labels.
   - One-click copy for config contents.

2. Add helper scripts.
   - Linux `wg-quick` wrapper script.
   - macOS import instructions or helper.
   - Windows PowerShell import instructions.

3. Evaluate a lightweight wrapper.
   - Decide whether to build a small CLI or desktop helper.
   - The first milestone 3 deliverable can be a CLI/helper script rather than a
     full GUI app if it reduces setup steps materially.

4. Add connection checks.
   - Show expected public egress IP or target route.
   - Show a test URL or command to verify the tunnel.
   - Explain common failure cases without exposing private key material.

Deliverables:

- QR-based mobile flow,
- platform-specific helper flow,
- updated screenshots and live smoke tests.

## Workstream 7: Routing Constraints And Censorship Resistance

Target outcome: users can request route constraints, including avoiding Germany,
and the scheduler enforces them.

Tasks:

1. Extend session intent.
   - Add route policy fields such as `excludeCountries`, `excludeCities`, and
     possibly `preferredRegions`.
   - Store route policy in session spec and artifacts.

2. Enforce in route selection.
   - Filter ingress and egress gates by policy.
   - Filter intermediate route metadata if DoubleZero exposes node path data.
   - If only gate endpoints are visible, document that enforcement applies to
     Hyperspace ingress and egress gates, not opaque DoubleZero internals.

3. Add UI controls.
   - Add an advanced routing section.
   - Include a simple "Avoid Germany" option.
   - Show when the policy makes route selection impossible.

4. Add validation.
   - Unit tests for route filtering.
   - Live smoke creating a config with Germany excluded.
   - Dashboard/report evidence showing the selected path avoids excluded
     endpoints.

Deliverables:

- route policy schema and API,
- scheduler enforcement,
- UI control,
- tests and acceptance evidence.

## Suggested Implementation Order

1. Create the deployment automation skeleton and gate inventory extensions.
2. Add route policy schema and scheduler enforcement early, because it affects
   session creation and UI.
3. Add billing data model and ledger foundations before top-up UI.
4. Add OAuth and Solana wallet account linking.
5. Add balance/top-up and config management UI.
6. Add WireGuard UX improvements.
7. Run scale-out waves and capture final dashboard screenshots.

## Acceptance Evidence To Capture

- Mainnet gate inventory and health table showing expanded footprint.
- Deployment automation dry-run and execute logs for a new gate.
- Billing import, rating, markup, ledger, and top-up flow documentation.
- Web screenshots:
  - social login onboarding,
  - Solana wallet link,
  - balance top-up,
  - config management,
  - route policy with Germany excluded.
- Grafana dashboard screenshots for the expanded footprint.
- Benchmark screenshots after scale-out.
- Live smoke outputs for config creation and connection UX.

## Key Risks

- DoubleZero metering format may not be stable or available in time. Mitigate
  with a raw import adapter and a fixture-based importer.
- Provider footprint may exceed manual operations capacity. Mitigate with
  idempotent host automation before adding many new PoPs.
- Solana wallet authentication can create account-linking edge cases. Mitigate
  with nonce expiry, replay prevention, and explicit account-link confirmation.
- Route exclusion may be limited by visibility into DoubleZero internals.
  Mitigate by clearly documenting whether exclusion applies to Hyperspace gates
  only or to full underlying path metadata.
- Billing suspension logic can interrupt active users. Mitigate with warnings,
  grace periods, and explicit policy configuration.
