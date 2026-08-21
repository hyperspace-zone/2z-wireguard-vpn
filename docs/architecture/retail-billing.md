# Hyperspace retail billing

## Scope and relationship to DoubleZero

DoubleZero bills the `hyperspace` tenant at the wholesale layer. Its current
tenant model is a fixed 2Z amount per DoubleZero epoch. Hyperspace does not
pretend that every customer owns a DoubleZero tenant or requires a DoubleZero
sentinel authority. Hyperspace pays the tenant invoice and maintains a separate
retail ledger for each Hyperspace account.

Wholesale cost events are imported into `doublezero_tenant_cost_events` by
DoubleZero epoch. They are used for reconciliation, margin reporting, and
alerts, but they are not copied directly into a single customer's bill. Retail
revenue is compared with wholesale 2Z cost after applying an operator-supplied
2Z/USD quote. This keeps the retail model compatible if DoubleZero changes the
tenant rate without rewriting historical customer charges.

## Retail price and metering

Every account has one versioned price plan. A plan contains:

- a monthly price per active VPN config, prorated by active seconds using a
  fixed 30-day billing month;
- a price per decimal GB of accepted payload traffic;
- grace, withdrawal cooldown, and minimum withdrawal settings.

The canonical traffic quantity is measured only on the egress assignment:

`forwarded_to_destination_bytes + forwarded_from_destination_bytes`

These are nftables counters for accepted customer payload. Ingress counters,
WireGuard transport counters, `doublezero0` bytes, retransmission overhead, and
the same payload observed at another gate are not added. Counter deltas are
partitioned by gate boot ID and assignment generation. A delta crossing a
rating boundary is prorated by overlap duration.

Each `(session UUID, window start, window end)` rating is unique. Labels may be
reused, but UUIDs cannot. Calculations use one millionth of a currency minor
unit and carry the fractional remainder on the account, so frequent settlement
does not round each sample up.

The safe default `pilot` plan has zero rates. A paid plan must be created and
explicitly assigned. `RETAIL_BILLING_MODE=shadow` records ratings without
posting debits. `enforce` posts debits and runs the balance lifecycle.

## Balances and credits

The immutable ledger is the accounting record. Balance buckets express which
funds may be spent or withdrawn:

- `cash`: verified Solana token deposits; withdrawable when unused;
- `promotional`: operator credits; spendable but never withdrawable;
- `reserved_withdrawal`: cash reserved by a pending withdrawal;
- `debt`: usage accepted beyond available prepaid funds.

Usage consumes promotional credit first, then unreserved cash, then creates
debt. New cash or promotional credits repay debt before becoming available.
All VPN configs belonging to one account share these buckets. Accounts are not
merged into organizations.

The active Milestone 3 settlement asset is native SOL. Each account has a
random custodial Solana wallet, and its finalized on-chain lamport balance is
the source of truth presented to the customer. Issuing a VPN config performs an
idempotent `0.0001 SOL` transfer from that wallet to the platform revenue
treasury; the account also pays the current Solana transaction fee. The config
does not enter reconciliation until the transfer is finalized.

The existing versioned usage ledger and DoubleZero wholesale reconciliation
remain available for shadow rating. Legacy SPL/USDC deposits, sweeps, and
withdrawals are retained in code for compatibility but are not the active
native-SOL customer flow. Native SOL withdrawal is disabled until a separate
cooldown and fee policy is approved.

## Exhaustion lifecycle

1. An account with a negative available balance enters `grace`.
2. Email lists the affected config UUIDs/labels and the exact suspension time.
3. A finalized deposit before the deadline restores the account.
4. If the deadline passes, the worker requests revocation of every nonterminal
   config and sends a second email.
5. Revoked configs never reactivate automatically after payment.

The worker uses a durable notification outbox with dedupe keys and retry
backoff. Resend failures do not roll back financial transactions.

## Withdrawals

Only verified paid cash can be withdrawn. The user enters a valid Solana
destination for each request; Hyperspace does not require or retain a linked
browser wallet. Promotional credit and debt are excluded. All VPN configs must
be terminal before a request is accepted. Cash is reserved at request time,
and the cooldown restarts whenever an active config appears.

The withdrawal worker signs an SPL-token transfer with the encrypted custodial
account key and a dedicated SOL-funded fee payer. It persists the transaction
signature before broadcast and confirms only a finalized transaction. A ledger
debit and cash reduction are posted only after finalization.

For production, keep `SOLANA_WITHDRAWALS_ENABLED=false` until the fee payer,
RPC, mint, and live E2E are verified. A separate VM is not required at current
scale. The signer should become a separately isolated service or HSM-backed
signer before materially large balances are held.

## Administration

The web network admin uses a normal authenticated bearer session. Access can be
assigned in deployment configuration with a comma-separated, case-insensitive
`BILLING_ADMIN_EMAILS` allowlist. The account must contain a verified identity
for the configured email; merely registering an unverified address does not
grant access. A database `billing_admin` or `platform_admin` role is the
alternative for per-account role management. The static `ADMIN_TOKEN` remains
an operator fallback and is never sent to the browser.

The admin page exposes every customer's active and historical VPN config,
native SOL config payment and finalized deposit. It also reads the platform
treasury's current finalized native SOL balance through the control-plane RPC.
An RPC failure is shown as unavailable and does not prevent the remaining admin
data from loading. Traffic totals and time-series charts use raw egress
assignment counters, so they remain independent from the disabled legacy USD
usage-rating model.

Legacy USD plans and promotional-credit controls are intentionally absent from
the web admin. Their database records and admin-authenticated API endpoints are
kept temporarily for compatibility and migration, but do not affect native SOL
config payments while `RETAIL_BILLING_ENABLED=false`. `billing_admin` is
restricted to billing endpoints; only `platform_admin` can use gate, job,
session, and audit administration.

Assign one or more deployment-managed administrators in
`/etc/hyperspace/control-plane-api.env`, then restart the API:

```bash
BILLING_ADMIN_EMAILS=operator@hyperspace.zone,finance@hyperspace.zone
systemctl restart hyperspace-control-plane-api
```

Alternatively, grant a database-backed role on the control-plane host:

```bash
cd /opt/2z-wireguard-vpn
scripts/grant-billing-admin.mjs \
  --env-file /etc/hyperspace/control-plane-api.env \
  --email operator@hyperspace.zone
```

Use `--revoke` to remove the role.

## Required runtime settings

API and worker share the private `SOLANA_RPC_URL`, asset identifier, token
decimals, and base-units-per-billing-unit settings. A submitted transaction
hash is always finalized and decoded through this private endpoint. The worker
additionally receives `SOLANA_HISTORY_RPC_URL`; only address-based signature
discovery and historical transaction decoding use that history-capable
endpoint. Only hashes supplied to the live payment flow use `SOLANA_RPC_URL`.
Both paths apply the same verification and idempotent receipt claim before any
credit is posted.

For Solana-mainnet contours, inject the control-plane-only `SOLANA_RPC_URL`
through the runtime environment or secret management. Documentation uses
`https://solana-rpc.example.invalid` and `wss://solana-rpc.example.invalid` as
non-resolving placeholders; never commit the real HTTP or WebSocket endpoint.
The WebSocket endpoint is reserved for future subscription consumers and is not
required by the current HTTP polling implementation. Set the direct scan period
to 600 seconds and cap Helius history lookups at 8 requests per second. Solana
testnet must use a separate testnet RPC.

```dotenv
RETAIL_BILLING_ENABLED=false
RETAIL_BILLING_MODE=shadow
RETAIL_BILLING_INTERVAL_SECONDS=300
RETAIL_BILLING_SETTLEMENT_LAG_SECONDS=120
EMAIL_PROVIDER=resend
RESEND_API_KEY=secret
EMAIL_FROM=Hyperspace <no-reply@hyperspace.zone>
EMAIL_REPLY_TO=gatekeepers@hyperspace.zone
SOLANA_WITHDRAWALS_ENABLED=false
SOLANA_REVENUE_SWEEPS_ENABLED=false
SOLANA_REVENUE_TREASURY_ADDRESS=platform-wallet-public-key
CUSTODIAL_WALLET_ENCRYPTION_KEY=the-same-key-as-the-api
SOLANA_FEE_PAYER_SECRET_KEY=[64-byte Solana secret-key JSON array]
```

Keep the legacy monthly/traffic rating loop disabled for the native-SOL
one-time issuance model. Enable it only when a versioned SOL-denominated usage
plan and its balance enforcement policy are deployed together.

Never commit RPC credentials, Resend keys, encryption keys, or fee-payer keys.
