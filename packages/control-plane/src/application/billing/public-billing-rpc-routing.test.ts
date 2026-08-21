import assert from "node:assert/strict";
import test from "node:test";
import type { TransactionalQueryable } from "../../db/queryable.js";
import { reconcileSubmittedSolanaTopups, type BillingConfig } from "./public-billing.scenario.js";

const privateRpc = "https://private-rpc.invalid";
const historyRpc = "https://mainnet.helius-rpc.com/?api-key=fixture";
const transactionSignature = "5".repeat(88);

test("a submitted transaction hash is checked only through the private RPC", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const result = await reconcileSubmittedSolanaTopups(topupDb(transactionSignature), billingConfig(async (url, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string };
    calls.push({ url: String(url), method: request.method });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [null] } }));
  }));

  assert.equal(result.checked, 1);
  assert.equal(result.pending, 1);
  assert.deepEqual(calls, [{ url: privateRpc, method: "getSignatureStatuses" }]);
});

test("an intent without a transaction hash discovers signatures only through the history RPC", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const result = await reconcileSubmittedSolanaTopups(topupDb(null), billingConfig(async (url, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string };
    calls.push({ url: String(url), method: request.method });
    const result = request.method === "getSignaturesForAddress"
      ? [{ signature: transactionSignature, err: null }]
      : { value: [null] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  }));

  assert.equal(result.checked, 1);
  assert.equal(result.pending, 1);
  assert.deepEqual(calls, [
    { url: historyRpc, method: "getSignaturesForAddress" },
    { url: historyRpc, method: "getSignatureStatuses" }
  ]);
});

function billingConfig(fetchImpl: typeof fetch): BillingConfig {
  return {
    currency: "USD",
    solanaTokenSymbol: "USDC",
    solanaTokenMint: "Mint111111111111111111111111111111111111111",
    solanaRpcUrl: privateRpc,
    solanaHistoryRpcUrl: historyRpc,
    solanaHistoryRpcRequestsPerSecond: 1000,
    solanaTokenBaseUnitsPerBillingMinor: 10_000,
    solanaTokenDecimals: 6,
    solanaExplorerTransactionBaseUrl: "https://orbmarkets.io/tx/",
    usageMarkupBps: 1500,
    fetchImpl
  };
}

function topupDb(hash: string | null): TransactionalQueryable {
  return {
    async query<Row extends object>(sql: string): Promise<{ rows: Row[] }> {
      if (!sql.includes("FROM topup_intents") || !sql.includes("ORDER BY updated_at")) {
        throw new Error(`unexpected test query: ${sql}`);
      }
      return { rows: [{
        id: "11111111-1111-4111-8111-111111111111",
        accountId: "22222222-2222-4222-8222-222222222222",
        provider: "solana",
        status: "submitted",
        amountMinor: 100,
        currency: "USD",
        chain: "solana",
        tokenSymbol: "USDC",
        tokenMint: "Mint111111111111111111111111111111111111111",
        treasuryAddress: "Treasury11111111111111111111111111111111111",
        reference: "hs_reference_123",
        expectedSender: null,
        transactionSignature: hash,
        expiresAt: "2099-01-01T00:00:00.000Z",
        submittedAt: "2026-08-20T00:00:00.000Z",
        confirmedAt: null,
        createdAt: "2026-08-20T00:00:00.000Z"
      }] as Row[] };
    },
    async transaction<T>(): Promise<T> {
      throw new Error("transaction is not expected in this test");
    }
  };
}
