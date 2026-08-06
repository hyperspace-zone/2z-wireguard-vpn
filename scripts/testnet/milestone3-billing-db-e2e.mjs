#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { createDatabase } from "../../packages/db/dist/index.js";
import {
  applyBillingCredit,
  cancelOwnedWithdrawal,
  createWithdrawalRequest,
  ensureCustodialSolanaWallet,
  readAccountBillingSummary,
  reconcileDirectSolanaDeposits,
  registerUser
} from "../../packages/control-plane/dist/index.js";

const databaseUrl = process.env.DATABASE_URL || "";
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const runId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
const email = `billing-db-e2e-${runId}@ostealmar.resend.app`;
const password = `Hs-${randomBytes(18).toString("base64url")}`;
const walletEncryptionKey = randomBytes(32);
const tokenMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const initialDepositSignature = "5".repeat(88);
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
    solanaTokenSymbol: "USDC",
    solanaTokenMint: tokenMint,
    solanaRpcUrl: "https://rpc.testnet.hyperspace.zone",
    solanaTokenBaseUnitsPerBillingMinor: 10_000,
    solanaTokenDecimals: 6,
    solanaExplorerTransactionBaseUrl: "https://orbmarkets.io/tx/",
    usageMarkupBps: 1500,
    fetchImpl: directDepositRpcFixture({
      signature: initialDepositSignature,
      treasury: wallet.publicKey,
      mint: tokenMint,
      amountBaseUnits: "25000000"
    })
  };
  const initialDeposit = await reconcileDirectSolanaDeposits(db, config, {
    batchSize: 25,
    scanIntervalSeconds: 1,
    walletId: wallet.id
  });
  assertEqual(initialDeposit.depositsCredited, 1, "permanent address deposit is discovered");
  assertEqual(initialDeposit.creditedMinor, 2500, "arbitrary deposit amount is credited");
  const summary = await readAccountBillingSummary(db, accountId, config);
  assertEqual(summary.balanceMinor, 2200, "deposit repays debt before increasing balance");
  assertEqual(summary.buckets.cashMinor, 2200, "only unused deposited funds remain withdrawable cash");
  assertEqual(summary.buckets.debtMinor, 0, "deposit clears existing debt");
  const sweepResult = await db.query(
    `SELECT status, amount_minor::text::int AS "amountMinor",
            token_amount_base_units::text AS "tokenAmountBaseUnits"
     FROM billing_cash_sweep_requests
     WHERE account_id = $1 AND source_type = 'direct_deposit_debt_repayment' AND source_id = $2`,
    [accountId, initialDepositSignature]
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

  const externalWallet = "AtfyG36NMHJqZKHmeoNTniFN3QwdXYA4oVXCbEqXr8zL";
  assertEqual(await createWithdrawalRequest(db, actor, {
    amountMinor: 1000,
    destinationAddress: "not-a-solana-address"
  }, config), "invalid_withdrawal_destination", "withdrawal rejects an invalid destination");
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

  config.fetchImpl = directDepositRpcFixture({
    signature: directDepositSignature,
    treasury: wallet.publicKey,
    mint: tokenMint,
    amountBaseUnits: "1819440"
  });
  await db.query(
    "UPDATE solana_deposit_scan_cursors SET next_scan_at = now() WHERE wallet_id = $1 AND token_mint = $2",
    [wallet.id, tokenMint]
  );
  const directDeposit = await reconcileDirectSolanaDeposits(db, config, {
    batchSize: 25,
    scanIntervalSeconds: 1,
    walletId: wallet.id
  });
  assertEqual(directDeposit.depositsCredited, 1, "direct deposit is discovered without a memo");
  assertEqual(directDeposit.creditedMinor, 181, "direct deposit credits only complete billing minor units");
  const afterDirectDeposit = await readAccountBillingSummary(db, accountId, config);
  assertEqual(afterDirectDeposit.balanceMinor, cancelled.balanceMinor + 181, "direct deposit updates the account balance");
  assertEqual(afterDirectDeposit.deposit?.address, wallet.publicKey, "billing summary exposes the permanent deposit address");
  const listedDeposit = afterDirectDeposit.deposits.find((deposit) => deposit.transactionSignature === directDepositSignature);
  assertEqual(listedDeposit?.tokenAmountBaseUnits, "1819440", "deposit history preserves exact token units");
  assertEqual(listedDeposit?.explorerUrl, `https://orbmarkets.io/tx/${directDepositSignature}`, "deposit history links to the configured explorer");
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
    scanIntervalSeconds: 1,
    walletId: wallet.id
  });
  assertEqual(duplicateScan.duplicates, 1, "repeated direct deposit scan is idempotent");
  const directLedger = await db.query(
    `SELECT count(*)::text::int AS count
     FROM balance_ledger_entries
     WHERE source_type = 'solana_direct_deposit' AND source_id = $1`,
    [directDepositSignature]
  );
  assertEqual(directLedger.rows[0]?.count, 1, "direct deposit creates one ledger entry");
  const globalReceipt = await db.query(
    "SELECT count(*)::text::int AS count FROM solana_payment_receipts WHERE transaction_signature = $1",
    [directDepositSignature]
  );
  assertEqual(globalReceipt.rows[0]?.count, 1, "transaction signature has exactly one global payment receipt");

  console.log(JSON.stringify({
    ok: true,
    wallet: wallet.publicKey,
    balanceMinor: afterDirectDeposit.balanceMinor,
    cashMinor: afterDirectDeposit.buckets.cashMinor,
    promotionalMinor: cancelled.buckets.promotionalMinor,
    duplicateDepositProtected: true,
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

function directDepositRpcFixture({ signature, treasury, mint, amountBaseUnits }) {
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
            instructions: []
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
