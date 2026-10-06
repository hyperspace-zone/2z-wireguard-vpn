import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "@hyperspace-zone/db";
import type { BillingConfig } from "@hyperspace-zone/control-plane";
import { publicBillingSummaryResponseSchema } from "@hyperspace-zone/contracts";
import { registerPublicBillingRoutes } from "./billing.routes.js";

test("startup QR warmup reads only a bounded set of public addresses and does not bypass authorization", async () => {
  let query = "";
  const db = { async query(sql: string) { query = sql; return { rows: [{ publicKey: "11111111111111111111111111111111" }] }; } } as unknown as Database;
  const app = Fastify();
  registerPublicBillingRoutes(app, { db, billing: {} as BillingConfig, custodialEncryptionKey: null,
    requireUser: async (_request, reply) => { reply.code(401).send({ error: "auth_required" }); return null; }
  });
  await app.ready();
  assert.match(query, /public_key/);
  assert.match(query, /disabled_at IS NULL/);
  assert.match(query, /LIMIT 16/);
  assert.match(query, /MAX\(auth_sessions.last_seen_at\)/);
  assert.doesNotMatch(query, /users.last_seen_at/);
  assert.doesNotMatch(query, /encrypted|secret|balance/);
  assert.equal((await app.inject("/v1/public/billing")).statusCode, 401);
  await app.close();
});

test("optional QR warmup failure does not prevent API startup or expose the database error", async () => {
  const db = { async query() { throw new Error("private database failure"); } } as unknown as Database;
  const app = Fastify();
  registerPublicBillingRoutes(app, { db, billing: {} as BillingConfig, custodialEncryptionKey: null,
    requireUser: async (_request, reply) => { reply.code(401).send({ error: "auth_required" }); return null; }
  });
  await app.ready();
  const response = await app.inject("/v1/public/billing");
  assert.equal(response.statusCode, 401);
  assert.doesNotMatch(response.body, /private database/);
  await app.close();
});

test("Billing nullable deposit serializer preserves object/null responses and filters private fields", async () => {
  const base = { accountId: "fixture", balanceMinor: 0, currency: "SOL", ledger: [], deposits: [],
    buckets: { cashMinor: 0, promotionalMinor: 0, reservedWithdrawalMinor: 0, debtMinor: 0 },
    state: { state: "active", overdrawnAt: null, suspensionDueAt: null, suspendedAt: null, withdrawalEligibleAt: null, lastSettledAt: null },
    plan: { id: "fixture", code: "pilot", version: 1, displayName: "Pilot", currency: "SOL", activeConfigMonthlyMinor: 0,
      trafficPerGbMinor: 0, gracePeriodSeconds: 0, withdrawalCooldownSeconds: 0, minimumWithdrawalMinor: 0 },
    availableBalanceMinor: 0, withdrawableBalanceMinor: 0, usage: [], withdrawals: [], walletBalanceBaseUnits: null,
    walletSpendableBaseUnits: null, walletRentReserveBaseUnits: null, walletBalanceStatus: "loading", configPriceBaseUnits: "0", configTrafficLimitBytes: "0" };
  const deposit = { chain: "solana", address: "fixture-address", tokenSymbol: "SOL", tokenMint: "native", tokenDecimals: 9, qrSvg: "<svg/>" };
  const app = Fastify();
  app.get("/null", { schema: { response: { 200: publicBillingSummaryResponseSchema } } }, async () => ({ ...base, deposit: null }));
  app.get("/object", { schema: { response: { 200: publicBillingSummaryResponseSchema } } }, async () => ({ ...base, deposit: { ...deposit, privateKey: "must-not-be-sent" } }));
  app.get("/invalid", { schema: { response: { 200: publicBillingSummaryResponseSchema } } }, async () => ({ ...base, deposit: {} }));
  assert.equal((await app.inject("/null")).json().deposit, null);
  const response = await app.inject("/object");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().deposit, deposit);
  assert.doesNotMatch(response.body, /privateKey|must-not-be-sent/);
  assert.equal((await app.inject("/invalid")).statusCode, 500);
  await app.close();
});

test("wallet display is authorized on every read, never cached, and reports RPC failures without zero balances", async () => {
  let rpcCalls = 0;
  let fail = false;
  const db = { query: async () => ({ rows: [{ publicKey: "fixture-wallet" }] }) } as unknown as Database;
  const billing = { solanaAssetKind: "native", solanaRpcUrl: "http://rpc.invalid", fetchImpl: async (_url, init) => {
    rpcCalls++;
    if (fail) throw new Error("private RPC error");
    const method = JSON.parse(String(init?.body)).method;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "getBalance" ? { value: 1200 } : 200 }));
  } } as BillingConfig;
  const app = Fastify(); registerPublicBillingRoutes(app, { db, billing, custodialEncryptionKey: null,
    requireUser: async (request, reply) => {
      if (request.headers["x-fixture-user"] === "yes") return { id: "user", accountId: "account", email: "fixture@example.invalid", displayName: "Fixture", avatarUrl: null };
      reply.code(401).send({ error: "auth_required" }); return null;
    }
  });
  assert.equal((await app.inject("/v1/public/billing/wallet-balance")).statusCode, 401);
  assert.equal(rpcCalls, 0);
  const headers = { "x-fixture-user": "yes" };
  for (let i = 0; i < 2; i++) {
    const response = await app.inject({ url: "/v1/public/billing/wallet-balance", headers });
    assert.equal(response.json().walletSpendableBaseUnits, "1000");
    assert.equal(response.json().walletBalanceStatus, "available");
  }
  assert.equal(rpcCalls, 4);
  fail = true;
  const response = await app.inject({ url: "/v1/public/billing/wallet-balance", headers });
  assert.equal(response.json().walletBalanceStatus, "unavailable");
  assert.equal(response.json().walletBalanceBaseUnits, null);
  assert.doesNotMatch(response.body, /private RPC error/);
  await app.close();
});
