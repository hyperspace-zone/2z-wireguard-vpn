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
unrecoverable. An external browser wallet can still be linked, but it is
optional and cannot replace or claim a wallet linked to another account.

## Solana Top-Up Flow

1. The user creates a top-up intent in the web app.
2. The API chooses the account custodial address as recipient and creates a
   random Solana reference public key.
3. The API returns a Solana Pay URI containing recipient, SPL mint, amount,
   reference, and memo.
4. The worker discovers finalized signatures indexed by the reference.
5. The RPC verifier requires all of the following before crediting the ledger:
   - signature status is `finalized` and has no transaction error;
   - the configured mint matches;
   - the recipient token-account owner is the account deposit wallet;
   - the exact base-unit amount reaches the recipient;
   - the memo exactly matches the top-up reference;
   - when an external sender was selected, it signed and authorized the
     transfer.
6. `topup_intents.transaction_signature` is unique, preventing replay across
   intents. A verified transaction creates one immutable ledger credit.

The default documented mapping is mainnet USDC:

```dotenv
SOLANA_TOKEN_SYMBOL=USDC
SOLANA_TOKEN_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
SOLANA_TOKEN_DECIMALS=6
SOLANA_TOKEN_BASE_UNITS_PER_BILLING_MINOR=10000
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

## Metering Import

The worker can poll an authenticated HTTPS metering feed. The adapter expects:

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

The worker persists raw payloads, uses ETag/Last-Modified cursors, deduplicates
provider record IDs, resolves each record to an account or session, applies the
configured basis-point markup, and writes immutable usage debits. Prometheus
alerts cover a never-successful or stale feed and rejected records.

Until DoubleZero publishes the tenant's exact metering response, an adapter in
front of this endpoint must map their payload to the documented normalized
record shape. The ledger/rating/reconciliation path does not depend on that
provider-specific shape.

## Verification

```bash
npm test
npm run test:milestone3:ui

# Against a migrated PostgreSQL environment:
npm run test:live:identity-db
npm run test:live:billing-db

# Full browser flow against testnet. Use a pre-verified test account when the
# Resend receiving key is not available.
HS_TEST_EXISTING_ACCOUNT=true \
HS_TEST_EMAIL=<verified-test-address> \
HS_TEST_PASSWORD=<test-password> \
npm run test:live:ui
```

The billing DB E2E creates an account wallet, confirms a fixture-backed
finalized transaction, checks the balance credit, proves signature replay is
rejected, and removes its account afterwards.

The live UI test covers the real testnet API, PostgreSQL, gates, Solana Pay
intent, custodial wallet display, config activation, one-time QR, OS helper,
download, revoke, and delete. It honors `429 Retry-After` responses instead of
disabling production-like abuse controls.
