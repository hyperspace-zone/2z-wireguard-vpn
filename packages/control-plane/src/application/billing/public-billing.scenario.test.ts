import assert from "node:assert/strict";
import test from "node:test";
import type { TransactionalQueryable } from "../../db/queryable.js";
import { readAccountBillingSummary, type BillingConfig } from "./public-billing.scenario.js";

test("deferred billing reads metadata without RPC, duplicate initialization, or a fabricated wallet balance", async () => {
  let rpcCalls = 0;
  const statements: string[] = [];
  const db = { query: async (sql: string) => {
    statements.push(sql);
    if (sql.includes("FROM billing_accounts")) return { rows: [{ balanceMinor: 100, currency: "USD" }] };
    if (sql.includes("FROM custodial_wallets")) return { rows: [{ publicKey: "fixture-wallet" }] };
    if (sql.includes("FROM billing_balance_buckets")) return { rows: [{ cashMinor: 100, promotionalMinor: 0, debtMinor: 0, reservedWithdrawalMinor: 0 }] };
    if (sql.includes("FROM billing_account_states")) return { rows: [{ state: "active" }] };
    if (/SELECT\s+billing_plan_versions.id/.test(sql)) return { rows: [{ code: "pilot" }] };
    return { rows: [] };
  } } as unknown as TransactionalQueryable;
  const config = { solanaAssetKind: "native", solanaTokenMint: "native", solanaTokenSymbol: "SOL",
    fetchImpl: async () => { rpcCalls++; throw new Error("Must not wait for RPC"); } } as unknown as BillingConfig;
  const summary = await readAccountBillingSummary(db, "account", config, { includeNativeBalance: false });
  assert.equal(summary.deposit?.address, "fixture-wallet");
  assert.equal(summary.walletBalanceStatus, "loading");
  assert.equal(summary.walletSpendableBaseUnits, null);
  assert.equal(rpcCalls, 0);
  assert.equal(statements.filter(sql => sql.includes("INSERT INTO billing_accounts ")).length, 1);
  assert.equal(statements.filter(sql => sql.includes("INSERT INTO billing_account_plan_assignments")).length, 1);
});
