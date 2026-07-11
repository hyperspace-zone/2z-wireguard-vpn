#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { createDatabase } from "../../packages/db/dist/index.js";
import {
  createSolanaTopupIntent,
  ensureCustodialSolanaWallet,
  readAccountBillingSummary,
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
  assertEqual(summary.balanceMinor, 2500, "verified top-up balance");

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

  console.log(JSON.stringify({ ok: true, wallet: wallet.publicKey, balanceMinor: summary.balanceMinor, replayProtected: true }, null, 2));
} finally {
  if (accountId) {
    await db.query("DELETE FROM audit_events WHERE account_id = $1", [accountId]);
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

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
