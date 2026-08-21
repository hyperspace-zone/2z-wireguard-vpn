import assert from "node:assert/strict";
import test from "node:test";
import type { TransactionalQueryable } from "../../db/queryable.js";
import {
  convertDepositToBillingMinor,
  directDepositRetryDelaySeconds,
  reconcileDirectSolanaDeposits
} from "./direct-solana-deposit.scenario.js";

test("direct deposit conversion never credits more USDC than was received", () => {
  assert.deepEqual(convertDepositToBillingMinor(0n, 1_819_440n, 10_000n), {
    amountMinor: 181,
    remainderBaseUnits: 9_440n
  });
});

test("direct deposit conversion carries sub-cent USDC into the next deposit", () => {
  assert.deepEqual(convertDepositToBillingMinor(9_440n, 560n, 10_000n), {
    amountMinor: 1,
    remainderBaseUnits: 0n
  });
});

test("failed history scans use bounded jittered backoff", () => {
  const schedule = [60, 300, 900, 3600];
  assert.equal(directDepositRetryDelaySeconds(0, schedule, () => 0.5), 60);
  assert.equal(directDepositRetryDelaySeconds(1, schedule, () => 0.5), 300);
  assert.equal(directDepositRetryDelaySeconds(2, schedule, () => 0.5), 900);
  assert.equal(directDepositRetryDelaySeconds(99, schedule, () => 0.5), 3600);
  assert.equal(directDepositRetryDelaySeconds(0, schedule, () => 0), 45);
  assert.equal(directDepositRetryDelaySeconds(0, schedule, () => 1), 75);
});

test("periodic wallet history uses the history RPC while account discovery stays private", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const db: TransactionalQueryable = {
    async query<Row extends object>(sql: string): Promise<{ rows: Row[] }> {
      if (sql.includes("FROM custodial_wallets") && sql.includes("next_scan_at")) {
        return { rows: [{
          id: "11111111-1111-4111-8111-111111111111",
          accountId: "22222222-2222-4222-8222-222222222222",
          chain: "solana",
          publicKey: "Wallet111111111111111111111111111111111111",
          keyFingerprint: "fixture",
          status: "active",
          createdAt: "2026-08-20T00:00:00.000Z"
        }] as Row[] };
      }
      if (sql.includes("FROM solana_deposit_scan_cursors")) return { rows: [] };
      if (sql.includes("INSERT INTO solana_deposit_scan_cursors")) return { rows: [] };
      throw new Error(`unexpected test query: ${sql}`);
    },
    async transaction<T>(): Promise<T> {
      throw new Error("transaction is not expected in this test");
    }
  };
  const result = await reconcileDirectSolanaDeposits(db, {
    currency: "USD",
    solanaTokenSymbol: "USDC",
    solanaTokenMint: "Mint111111111111111111111111111111111111111",
    solanaRpcUrl: "https://private-rpc.invalid",
    solanaHistoryRpcUrl: "https://mainnet.helius-rpc.com/?api-key=fixture",
    solanaHistoryRpcRequestsPerSecond: 1000,
    solanaTokenBaseUnitsPerBillingMinor: 10_000,
    solanaTokenDecimals: 6,
    solanaExplorerTransactionBaseUrl: "https://orbmarkets.io/tx/",
    usageMarkupBps: 1500,
    solanaAssetKind: "spl",
    fetchImpl: async (url, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      calls.push({ url: String(url), method: request.method });
      const rpcResult = request.method === "getTokenAccountsByOwner"
        ? { value: [{ pubkey: "Token1111111111111111111111111111111111111" }] }
        : [];
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: rpcResult }));
    }
  }, { batchSize: 1, scanIntervalSeconds: 600 });

  assert.equal(result.errors, 0);
  assert.deepEqual(calls, [
    { url: "https://private-rpc.invalid", method: "getTokenAccountsByOwner" },
    { url: "https://mainnet.helius-rpc.com/?api-key=fixture", method: "getSignaturesForAddress" }
  ]);
});
