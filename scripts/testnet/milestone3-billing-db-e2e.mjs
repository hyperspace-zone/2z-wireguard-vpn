#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { createDatabase } from "../../packages/db/dist/index.js";
import {
  createSolanaTopupIntent,
  applyBillingCredit,
  cancelOwnedWithdrawal,
  createWithdrawalRequest,
  ensureCustodialSolanaWallet,
  readAccountBillingSummary,
  reconcileDirectSolanaDeposits,
  registerUser,
  submitSolanaTopupSignature
} from "../../packages/control-plane/dist/index.js";

const databaseUrl = process.env.DATABASE_URL || "";
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const runId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
const email = `billing-db-e2e-${runId}@ostealmar.resend.app`;
const password = `Hs-${randomBytes(18).toString("base64url")}`;
const walletEncryptionKey = randomBytes(32);
const tokenMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const transactionSignature = "5".repeat(88);
const directDepositSignature = "6".repeat(88);
const db = createDatabase({ connectionString: databaseUrl, applicationName: "hyperspace-ms3-billing-e2e" });

let accountId = "";
try {
  const registration = await registerUser(db, { email, password, displayName: "Billing E2E" });
  if (typeof registration === "string") throw new Error(`registration failed: ${registration}`);
  const userRow = await db.query(`SELECT id, account_id AS "accountId" FROM users WHERE email = $1`, [email]);
  const actor = userRow.rows[0];
  if (!actor) throw new Error("registered user was not found");
  accountId = actor.accountId;

  const wallet = await ensureCustodialSolanaWallet(db, accountId, walletEncryptionKey);
  await readAccountBillingSummary(db, accountId);
  const debtFixture = await db.query(
    "UPDATE billing_balance_buckets SET debt_minor = 300, updated_at = now() WHERE account_id = $1",
    [accountId]
  );
  assertEqual(debtFixture.rowCount, 1, "debt fixture updates the initialized billing bucket");
  await db.query(
    `INSERT INTO balance_ledger_entries (
       account_id, entry_type, amount_minor, currency, source_type, source_id, description
     ) VALUES ($1, 'usage_charge', -300, 'USD', 'billing_e2e_debt', $2, 'Billing E2E debt fixture')`,
    [accountId, runId]
  );
  const config = {
    currency: "USD",
    solanaTreasuryAddress: "",
    solanaTokenSymbol: "USDC",
    solanaTokenMint: tokenMint,
    solanaRpcUrl: "https://rpc.testnet.hyperspace.zone",
    solanaTokenBaseUnitsPerBillingMinor: 10_000,
    solanaTokenDecimals: 6,
    topupIntentTtlSeconds: 3600,
    allowUnverifiedTopups: false,
    usageMarkupBps: 1500
  };
  const first = await createSolanaTopupIntent(db, actor, { amountMinor: 2500 }, config);
  if (typeof first === "string") throw new Error(`top-up creation failed: ${first}`);
  config.fetchImpl = rpcFixture({
    reference: first.topup.reference,
    treasury: wallet.publicKey,
    mint: tokenMint,
    amountBaseUnits: "25000000"
  });
  const confirmed = await submitSolanaTopupSignature(db, actor, {
    topupId: first.topup.id,
    transactionSignature
  }, config);
  if (typeof confirmed === "string" || confirmed.status !== "confirmed") {
    throw new Error(`top-up confirmation failed: ${JSON.stringify(confirmed)}`);
  }
  const summary = await readAccountBillingSummary(db, accountId, config);
  assertEqual(summary.balanceMinor, 2200, "verified top-up repays debt before increasing balance");
  assertEqual(summary.buckets.cashMinor, 2200, "only the unused top-up remains withdrawable cash");
  assertEqual(summary.buckets.debtMinor, 0, "verified top-up clears existing debt");
  const sweepResult = await db.query(
    `SELECT status, amount_minor::text::int AS "amountMinor",
            token_amount_base_units::text AS "tokenAmountBaseUnits"
     FROM billing_cash_sweep_requests
     WHERE account_id = $1 AND source_type = 'topup_debt_repayment'`,
    [accountId]
  );
  assertEqual(sweepResult.rows[0]?.status, "pending", "debt repayment creates a revenue sweep");
  assertEqual(sweepResult.rows[0]?.amountMinor, 300, "revenue sweep contains only repaid debt");
  assertEqual(sweepResult.rows[0]?.tokenAmountBaseUnits, "3000000", "revenue sweep preserves SPL base units");

  await applyBillingCredit(db, {
    accountId,
    amountMinor: 500,
    kind: "promotional",
    sourceType: "billing_e2e_credit",
    sourceId: runId,
    description: "Billing E2E promotional credit"
  });
  await applyBillingCredit(db, {
    accountId,
    amountMinor: 500,
    kind: "promotional",
    sourceType: "billing_e2e_credit",
    sourceId: runId,
    description: "Idempotency replay"
  });
  const credited = await readAccountBillingSummary(db, accountId, config);
  assertEqual(credited.buckets.promotionalMinor, 500, "manual credit is promotional and idempotent");
  assertEqual(credited.withdrawableBalanceMinor, 2200, "promotional credit is not withdrawable");

  const externalWallet = "11111111111111111111111111111111";
  await db.query(
    `INSERT INTO wallet_links (account_id, user_id, chain, public_key, label)
     VALUES ($1, $2, 'solana', $3, 'Billing E2E destination')`,
    [accountId, actor.id, externalWallet]
  );
  const withdrawal = await createWithdrawalRequest(db, actor, {
    amountMinor: 1000,
    destinationAddress: externalWallet
  }, config);
  if (typeof withdrawal === "string") throw new Error(`withdrawal creation failed: ${withdrawal}`);
  const reserved = await readAccountBillingSummary(db, accountId, config);
  assertEqual(reserved.buckets.reservedWithdrawalMinor, 1000, "withdrawal reserves paid cash");
  assertEqual(reserved.availableBalanceMinor, 1700, "reserved cash is unavailable for usage");
  assertEqual(await cancelOwnedWithdrawal(db, actor, withdrawal.withdrawal.id), "cancelled", "withdrawal cancellation");
  const cancelled = await readAccountBillingSummary(db, accountId, config);
  assertEqual(cancelled.buckets.reservedWithdrawalMinor, 0, "cancellation releases reserved cash");

  const second = await createSolanaTopupIntent(db, actor, { amountMinor: 2500 }, config);
  if (typeof second === "string") throw new Error(`second top-up creation failed: ${second}`);
  config.fetchImpl = rpcFixture({
    reference: second.topup.reference,
    treasury: wallet.publicKey,
    mint: tokenMint,
    amountBaseUnits: "25000000"
  });
  const replay = await submitSolanaTopupSignature(db, actor, {
    topupId: second.topup.id,
    transactionSignature
  }, config);
  assertEqual(replay, "topup_transaction_reused", "transaction replay protection");

  config.fetchImpl = directDepositRpcFixture({
    signature: directDepositSignature,
    treasury: wallet.publicKey,
    mint: tokenMint,
    amountBaseUnits: "1819440",
    reference: second.topup.reference
  });
  const directDeposit = await reconcileDirectSolanaDeposits(db, config, {
    batchSize: 25,
    scanIntervalSeconds: 1
  });
  assertEqual(directDeposit.depositsCredited, 1, "direct deposit is discovered without a memo");
  assertEqual(directDeposit.creditedMinor, 181, "direct deposit credits only complete billing minor units");
  const afterDirectDeposit = await readAccountBillingSummary(db, accountId, config);
  assertEqual(afterDirectDeposit.balanceMinor, cancelled.balanceMinor + 181, "direct deposit updates the account balance");
  const remainder = await db.query(
    `SELECT remainder_base_units::text AS "remainderBaseUnits"
     FROM solana_deposit_remainders WHERE account_id = $1 AND token_mint = $2`,
    [accountId, tokenMint]
  );
  assertEqual(remainder.rows[0]?.remainderBaseUnits, "9440", "sub-cent USDC is carried forward");

  await db.query(
    "UPDATE solana_deposit_scan_cursors SET next_scan_at = now() WHERE wallet_id = $1 AND token_mint = $2",
    [wallet.id, tokenMint]
  );
  const duplicateScan = await reconcileDirectSolanaDeposits(db, config, {
    batchSize: 25,
    scanIntervalSeconds: 1
  });
  assertEqual(duplicateScan.duplicates, 1, "repeated direct deposit scan is idempotent");
  const directLedger = await db.query(
    `SELECT count(*)::text::int AS count
     FROM balance_ledger_entries
     WHERE source_type = 'solana_direct_deposit' AND source_id = $1`,
    [directDepositSignature]
  );
  assertEqual(directLedger.rows[0]?.count, 1, "direct deposit creates one ledger entry");

  console.log(JSON.stringify({
    ok: true,
    wallet: wallet.publicKey,
    balanceMinor: afterDirectDeposit.balanceMinor,
    cashMinor: afterDirectDeposit.buckets.cashMinor,
    promotionalMinor: cancelled.buckets.promotionalMinor,
    replayProtected: true,
    withdrawalLifecycle: true,
    directDepositReconciled: true
  }, null, 2));
} finally {
  if (accountId) {
    await db.query("DELETE FROM audit_events WHERE account_id = $1", [accountId]);
    await db.query("DELETE FROM withdrawal_requests WHERE account_id = $1", [accountId]);
    await db.query("DELETE FROM accounts WHERE id = $1", [accountId]);
  }
  await db.close();
}

function rpcFixture({ reference, treasury, mint, amountBaseUnits }) {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const result = request.method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
      : {
        slot: 123,
        blockTime: 1_700_000_000,
        transaction: { message: { accountKeys: [{ pubkey: treasury, signer: false }], instructions: [{ program: "spl-memo", parsed: reference }] } },
        meta: {
          err: null,
          innerInstructions: [],
          preTokenBalances: [{ accountIndex: 0, mint, owner: treasury, uiTokenAmount: { amount: "0" } }],
          postTokenBalances: [{ accountIndex: 0, mint, owner: treasury, uiTokenAmount: { amount: amountBaseUnits } }]
        }
      };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
}

function directDepositRpcFixture({ signature, treasury, mint, amountBaseUnits, reference }) {
  const tokenAccount = "TokenAccount11111111111111111111111111111111";
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    let result;
    if (request.method === "getTokenAccountsByOwner") {
      result = { value: [{ pubkey: tokenAccount }] };
    } else if (request.method === "getSignaturesForAddress") {
      result = [{ signature, err: null, blockTime: Math.floor(Date.now() / 1000) }];
    } else if (request.method === "getSignatureStatuses") {
      result = { value: [{ err: null, confirmationStatus: "finalized" }] };
    } else {
      result = {
        slot: 456,
        blockTime: Math.floor(Date.now() / 1000),
        transaction: {
          message: {
            accountKeys: [{ pubkey: treasury, signer: false }],
            instructions: reference ? [{ program: "spl-memo", parsed: reference }] : []
          }
        },
        meta: {
          err: null,
          innerInstructions: [],
          preTokenBalances: [],
          postTokenBalances: [{ accountIndex: 0, mint, owner: treasury, uiTokenAmount: { amount: amountBaseUnits } }]
        }
      };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
