# Milestone 3 production rollout

This runbook upgrades the production control plane from the operational
Milestone 2 tree to the Milestone 3 self-service and native SOL billing tree.
It is deliberately additive: existing sessions and gate assignments remain in
PostgreSQL and on the gates throughout the control-plane restart.

## Release integration

Merge current `main` into `milestone3-mainnet-scaleout`, resolve and test there,
then merge the resulting release candidate into `main`. Do not resolve the
original branch divergence directly in production. The release includes:

- migrations `0019`, `0021` through `0029`, plus any operational migration not
  yet applied to production;
- email OTP and Google OAuth identity linking;
- custodial Solana deposit wallets and native SOL config payments;
- billing administration and disabled-by-default usage enforcement;
- simplified config creation, QR/download helpers and routing exclusions;
- the operational monitoring, backup and managed gate rollout changes already
  present on `main`.

The SQL migrations add tables, columns, indexes and one enum value. They do not
rewrite or revoke an existing active session. Rolling application code back is
therefore possible without rolling the database schema back.

## Legacy session continuity

Before the release, production has ten customer-used MEV-X sessions in
`active` phase and twenty corresponding assignments in `applied` phase. Capture
the exact baseline immediately before maintenance:

```sql
SELECT u.email::text, s.id, s.label, s.desired_state::text, ss.phase::text,
       count(ga.id) AS assignments,
       count(*) FILTER (
         WHERE ga.desired_state = 'Applied' AND gas.phase = 'applied'
       ) AS applied_assignments
FROM users u
JOIN sessions s ON s.account_id = u.account_id
JOIN session_status ss ON ss.session_id = s.id
LEFT JOIN gate_assignments ga ON ga.session_id = s.id
LEFT JOIN gate_assignment_status gas ON gas.assignment_id = ga.id
WHERE lower(u.email::text) IN ('devops1@mev-x.com', 'devops2@mev-x.com')
  AND ss.phase = 'active'
GROUP BY u.email, s.id, s.label, s.desired_state, ss.phase
ORDER BY u.email, s.label;
```

These sessions are grandfathered by state, not by fabricated Solana
transactions. `SOLANA_CONFIG_PAYMENT_ENABLED` is checked only while creating a
new session. Do not insert fake `solana_config_payments` rows for legacy
sessions. Keep both usage enforcement controls disabled during the first
production release:

```text
BILLING_ENFORCE_POSITIVE_BALANCE=false
RETAIL_BILLING_ENABLED=false
RETAIL_BILLING_MODE=shadow
SOLANA_WITHDRAWALS_ENABLED=false
SOLANA_REVENUE_SWEEPS_ENABLED=false
```

If usage billing is enabled later, grant explicit promotional credit or assign
a separately documented legacy plan before switching enforcement on. That is a
separate billing decision from the one-time config issuance fee.

## Production secrets

Never commit runtime values. Prepare separate production values for:

- `CUSTODIAL_WALLET_ENCRYPTION_KEY`, shared only by the production API and
  worker;
- `SOLANA_RPC_URL`, using the same control-plane-only mainnet RPC service as
  staging;
- `SOLANA_REVENUE_TREASURY_ADDRESS`, backed by a production-only keypair and
  initialized with at least the current zero-data rent exemption;
- production Resend sending key, Google client secret, OTP hash secret and
  existing artifact encryption key.

The production E2E funder is not the revenue treasury and must not be loaded by
the API or worker. Keep it only on the operator/E2E host.

## Preserve staging wallet addresses

The production database already contains the users `stakr.space@gmail.com` and
`yadrena@gmail.com`, but their production account IDs differ from staging.
Encrypted wallet rows cannot be copied directly because their AES-GCM AAD
contains `account_id`. Use the migration tool to decrypt with the staging key,
validate the seed and public key, then encrypt under the production key and
production account ID:

```bash
npm run build

# dry-run first; env files are root-only and never committed
node scripts/billing/migrate-custodial-wallets.mjs \
  --source-env-file /root/hyperspace/secrets/wallet-cutover/source.env \
  --target-env-file /root/hyperspace/secrets/wallet-cutover/target.env \
  --email stakr.space@gmail.com \
  --email yadrena@gmail.com

CUTOVER_SOLANA_HISTORY_RPC_URL=https://api.mainnet-beta.solana.com \
  node scripts/billing/migrate-custodial-wallets.mjs \
  --source-env-file /root/hyperspace/secrets/wallet-cutover/source.env \
  --target-env-file /root/hyperspace/secrets/wallet-cutover/target.env \
  --email stakr.space@gmail.com \
  --email yadrena@gmail.com \
  --execute
```

Each env file has the standard names `DATABASE_URL`,
`CUSTODIAL_WALLET_ENCRYPTION_KEY` and `SOLANA_RPC_URL`. Use SSH tunnels when
running from the operator host; do not open PostgreSQL publicly. The public
history endpoint above is supplied only to this one cutover command and is not
stored in a production runtime env file. The tool is
dry-run by default, refuses an existing different target wallet, verifies the
private seed against the public address and seeds a finalized Solana scan
cursor. The cursor prevents historical staging deposits from being credited a
second time in the production ledger. The UI still reads the current native SOL
balance directly from chain.

Expected addresses after migration:

```text
stakr.space@gmail.com  7DBaeTkJRieMcpfJyf9i1GibTXFPpF6BV8FWx9Y4idoT
yadrena@gmail.com      DBjSKKB538D6D5CiCoodqNY5FBAr6GQCUYFRAkTXYGMf
```

Do not copy staging identities, auth sessions, deposit receipts, billing
ledger entries or VPN sessions into production.

## Cutover order

1. Merge and tag the tested release candidate; build only from that commit.
2. Verify a fresh production PostgreSQL backup with `pg_restore --list`.
3. Record the legacy-session query above and current gate assignment health.
4. Start a maintenance silence for web, API, worker and PostgreSQL alerts.
5. Stop the API and worker. Do not stop gate agents or revoke assignments.
6. Deploy the release and run every pending migration with
   `scripts/control-plane/restart-after-migrations` while services are stopped.
7. Run the wallet migration dry-run and execute modes before starting the API.
8. Install the production env with billing enforcement, withdrawals and sweeps
   disabled. Start with `SOLANA_CONFIG_PAYMENT_ENABLED=false`.
9. Start API and worker. Require healthy API, fresh worker snapshots and zero
   failed jobs. Re-run the legacy-session query and verify ten active sessions
   with two applied assignments each.
10. Test at least one existing MEV-X path without regenerating its config.
11. Verify OTP, Google login, Billing and a zero-cost config-create dry run.
12. Configure and initialize the production treasury, then set
    `SOLANA_CONFIG_PAYMENT_ENABLED=true` and restart only the API.
13. Run one production canary using the dedicated production E2E funder:
    deposit, finalized balance, `0.0001 SOL` config payment, active config,
    download/QR, route check and revoke.
14. Remove the silence only after Prometheus and Alertmanager have naturally
    returned healthy.

## Rollback

If migrations fail, services remain stopped and the pre-release binary is not
started against a partial schema. Restore only if PostgreSQL itself reports an
unrecoverable migration failure. If application health fails after successful
additive migrations, restore the previous application release and leave the
new schema in place. Existing gate assignments continue operating while the
control plane is unavailable; never delete sessions, assignments, rendered
plans or artifacts as part of rollback.
