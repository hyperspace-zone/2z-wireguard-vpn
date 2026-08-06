# Milestone 3 Billing And Wallets

## Account Wallet Model

Every authenticated account receives one randomly generated custodial Solana
wallet on first account load. The wallet is account-scoped, not derived from an
email address, so changing or linking an authentication provider does not
change the deposit address.

Only the public address is returned to the browser. The Ed25519 seed is stored
in `custodial_wallets.encrypted_key` as an AES-256-GCM payload using
`CUSTODIAL_WALLET_ENCRYPTION_KEY`. Use a key separate from
`ARTIFACT_ENCRYPTION_KEY`, keep it in the host secret store, and include it in
encrypted operational backups. Losing this key makes custodial funds
unrecoverable. Hyperspace does not link a browser wallet. The user may send
funds to the permanent account address from a wallet, exchange, or another
Solana account.

## Solana Deposit Flow

The first-class `/billing` page follows the deposit model used by centralized exchanges: it
shows one permanent address, a QR containing that raw address, the accepted
network and asset, and finalized deposit history. There is no amount selector,
payment intent, memo, sender restriction, or browser-wallet connection.
The Billing page reloads balance and history when the user selects `Refresh
deposits`; it does not submit or mutate an on-chain payment.

The available balance is also shown as a compact link immediately before the
authenticated identity in the application header. The Dashboard contains only
VPN config management and the gate catalog, so billing activity does not crowd
the primary network workflow.

1. The worker finds the configured SPL token account owned by each active
   custodial wallet.
2. It scans signatures incrementally with a durable per-token-account cursor.
   Pagination provides backfill after worker or RPC downtime.
3. The RPC verifier requires all of the following before recording a receipt:
   - signature status is `finalized` and has no transaction error;
   - the configured mint matches;
   - the recipient token-account owner is the account deposit wallet;
   - the finalized recipient balance delta is positive.
4. `solana_payment_receipts.transaction_signature` is the global primary key.
   Claiming the receipt, updating the remainder, posting the ledger entry, and
   updating balance buckets happen in one PostgreSQL transaction. Reprocessing
   the same signature cannot produce a second credit, even after a restart.
5. Billing uses integer currency minor units. Any received fraction below one
   cent is retained in `solana_deposit_remainders` and carried into the next
   deposit instead of being rounded up or lost.
6. When paid cash is consumed by usage or repays debt, an idempotent sweep
   transfers that amount from the account wallet to the configured Hyperspace
   revenue treasury. Unused cash stays available for withdrawal.

The history displays the exact finalized token amount, credited USD amount,
UTC observation time, and a transaction link. A sender may transfer any
positive amount. Exchange withdrawal fees are naturally handled because only
the amount that actually reached the account wallet is credited. Historical
`topup_intents` remain in the database for audit and legacy reconciliation, but
the public API cannot create new intents.

### Open-source indexing choice

At the current footprint, the production source is Solana JSON-RPC plus the
PostgreSQL cursor and receipt tables in this repository. It requires no hosted
webhook service, survives missed polling intervals, and can be replayed. The
API uses the open-source `qrcode` package to render the address QR.

Yellowstone gRPC is the preferred scale-out transport when polling many
thousands of wallets. It provides Geyser account and transaction streams, but
self-hosting it requires validator/Geyser infrastructure and a managed stream
still adds an external provider. Do not deploy that operational cost until RPC
scan latency or request volume demonstrates the need. The receipt primary key
remains the final idempotency boundary regardless of the event source.

The default documented mapping is mainnet USDC:

```dotenv
SOLANA_TOKEN_SYMBOL=USDC
SOLANA_TOKEN_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
SOLANA_TOKEN_DECIMALS=6
SOLANA_TOKEN_BASE_UNITS_PER_BILLING_MINOR=10000
SOLANA_EXPLORER_TX_BASE_URL=https://orbmarkets.io/tx/
SOLANA_DIRECT_DEPOSIT_SCAN_INTERVAL_SECONDS=30
SOLANA_DIRECT_DEPOSIT_SCAN_BATCH_SIZE=25
```

The custodial address is a normal Solana address and can also receive 2Z and
other SPL tokens. DoubleZero documents the mainnet 2Z mint as
`J6pQQ3FAcJQeWPPGppWRb4nM8jU3wLyYbRrLh7feMfvd` with eight decimals. Do not
switch automatic Hyperspace balance crediting to 2Z by changing only the mint:
USD-denominated intents also require a versioned, persisted oracle price quote.
The official price endpoint is
`https://sol-2z-oracle-api-v1.mainnet-beta.doublezero.xyz/swap-rate`. Quote
signature verification and the tenant billing token account/sentinel contract
must be agreed with DoubleZero before production 2Z sweeping or spending is
enabled.

`SOLANA_RPC_URL` is a secret. Configure the same endpoint on the API and worker;
never commit a provider URL containing a credential.

## Retail usage and DoubleZero wholesale reconciliation

Customer charges are produced from Hyperspace gate counters and the account's
versioned retail plan. See `docs/architecture/retail-billing.md`. They are not a
copy of a provider invoice and are not calculated from physical interface
traffic.

DoubleZero currently charges the complete `hyperspace` tenant a fixed 2Z rate
per DoubleZero epoch. Record each observed epoch charge through:

```text
POST /v1/admin/billing/doublezero/cost-events
```

The request includes `cluster`, `tenant`, `dzEpoch`, `tokenSymbol`, `tokenMint`,
`amountBaseUnits`, and optionally `usdCostMinor` plus the signed quote evidence.
The epoch key is idempotent. These events support wholesale cost, revenue, and
margin reconciliation; they never debit one arbitrary customer account.

## Legacy normalized metering adapter

The earlier MS3 adapter can poll an authenticated per-customer metering feed.
It expects:

```json
{
  "records": [
    {
      "recordId": "provider-stable-id",
      "sessionId": "session-uuid",
      "windowStart": "2026-07-11T10:00:00Z",
      "windowEnd": "2026-07-11T10:05:00Z",
      "bytesIn": 1000,
      "bytesOut": 2000,
      "doubleZeroCostMinor": 4,
      "currency": "USD"
    }
  ]
}
```

Configure:

```dotenv
DOUBLEZERO_METERING_URL=https://<metering-feed>
DOUBLEZERO_METERING_BEARER_TOKEN=<secret>
DOUBLEZERO_METERING_SOURCE_NAME=doublezero-hyperspace
DOUBLEZERO_METERING_CLUSTER=mainnet-beta
DOUBLEZERO_METERING_TENANT=hyperspace
DOUBLEZERO_METERING_INTERVAL_SECONDS=300
BILLING_USAGE_MARKUP_BPS=1500
```

The adapter persists raw payloads, uses ETag/Last-Modified cursors, deduplicates
provider record IDs, resolves each record to an account or session, applies the
configured basis-point markup, and writes immutable usage debits. Prometheus
alerts cover a never-successful or stale feed and rejected records.

Keep `DOUBLEZERO_METERING_URL` empty for the current fixed-per-epoch tenant
contract. This legacy path is only appropriate if DoubleZero later provides a
contractually authoritative per-Hyperspace-account allocation. It must not be
fed aggregate tenant bytes, because doing so would conflict with retail rating
and double-charge customers.

## Verification

```bash
npm test
npm run test:milestone3:ui

# Against a migrated PostgreSQL environment:
npm run test:live:identity-db
npm run test:live:billing-db

# Browser billing/admin/withdrawal flow. DATABASE_URL may be provided through
# an SSH tunnel to the testnet database.
npm run test:live:billing-ui

# Real OTP delivery requires a separate Resend Full Access key, not the
# send-only production key.
RESEND_RECEIVING_API_KEY=<full-access-key> npm run test:live:email

# Full browser flow against testnet. Use a pre-verified test account when the
# Resend receiving key is not available.
HS_TEST_EXISTING_ACCOUNT=true \
HS_TEST_EMAIL=<verified-test-address> \
HS_TEST_PASSWORD=<test-password> \
npm run test:live:ui
```

The billing DB E2E creates an account wallet, confirms fixture-backed finalized
transactions, checks exact token units and explorer history, checks the cash
and promotional buckets, proves signature replay and manual-credit replay are
rejected, exercises withdrawal reservation/cancellation, and removes its
account afterwards. Its fixture RPC scan is constrained to the newly created
wallet ID and cannot update cursors or balances belonging to other accounts.

The live UI test covers the real environment API, PostgreSQL, gates, permanent
deposit address and QR, deposit history, config activation, one-time WireGuard
QR, OS helper, download, revoke, and delete. It honors `429 Retry-After`
responses instead of disabling production-like abuse controls.
