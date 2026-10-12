import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { BillingConfig } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import { registerAdminBillingRoutes } from "./billing.routes.js";

const billing: BillingConfig = {
  currency: "SOL",
  solanaTokenSymbol: "SOL",
  solanaTokenMint: "native",
  solanaRpcUrl: "http://rpc.invalid",
  solanaTokenBaseUnitsPerBillingMinor: 1,
  solanaTokenDecimals: 9,
  solanaExplorerTransactionBaseUrl: "https://orbmarkets.io/tx/",
  usageMarkupBps: 1500,
  solanaAssetKind: "native",
  configPriceLamports: 100_000,
  configPaymentEnabled: true
};

const treasuryAddress = "DWAg34bbga73yiCh1ic9KLAv3B7FDk62GmUcamXF2Ds8";

test("billing admin overview contains config payments, deposits and asset metadata", async () => {
  const db = emptyDatabase();
  const app = Fastify();
  registerAdminBillingRoutes(app, {
    db,
    billing,
    treasury: { address: treasuryAddress, readBalance: async () => 12_345_678n },
    requireAdmin: async () => ({ kind: "admin", id: "admin-1" })
  });

  const response = await app.inject({ method: "GET", url: "/v1/admin/billing/customers" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.customers, []);
  assert.deepEqual(body.configs, []);
  assert.deepEqual(body.payments, []);
  assert.deepEqual(body.deposits, []);
  assert.deepEqual(
    { ...body.treasury, checkedAt: "checked" },
    {
      address: treasuryAddress,
      balanceBaseUnits: "12345678",
      status: "available",
      checkedAt: "checked"
    }
  );
  assert.deepEqual(body.asset, {
    symbol: "SOL",
    decimals: 9,
    explorerTransactionBaseUrl: "https://orbmarkets.io/tx/",
    configPriceBaseUnits: "100000"
  });
  await app.close();
});

test("billing admin overview remains available when the treasury RPC fails", async () => {
  const app = Fastify();
  registerAdminBillingRoutes(app, {
    db: emptyDatabase(),
    billing,
    treasury: {
      address: treasuryAddress,
      readBalance: async () => { throw new Error("RPC unavailable"); }
    },
    requireAdmin: async () => ({ kind: "admin", id: "admin-1" })
  });

  const response = await app.inject({ method: "GET", url: "/v1/admin/billing/customers" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    { ...response.json().treasury, checkedAt: "checked" },
    {
      address: treasuryAddress,
      balanceBaseUnits: null,
      status: "unavailable",
      checkedAt: "checked"
    }
  );
  await app.close();
});

test("billing admin traffic validates config IDs and maps the 7d range", async () => {
  const queries: unknown[][] = [];
  const db = {
    async query(_text: string, values?: unknown[]) {
      queries.push(values ?? []);
      return { rows: [] };
    }
  } as unknown as Database;
  const app = Fastify();
  registerAdminBillingRoutes(app, {
    db,
    billing,
    requireAdmin: async () => ({ kind: "admin", id: "admin-1" })
  });

  const invalid = await app.inject({ method: "GET", url: "/v1/admin/billing/traffic?sessionId=bad" });
  assert.equal(invalid.statusCode, 400);

  const sessionId = "90386aa8-73e5-4fe0-82c2-8b442e3ad47d";
  const response = await app.inject({ method: "GET", url: `/v1/admin/billing/traffic?range=7d&sessionId=${sessionId}` });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().range, "7d");
  assert.equal(response.json().bucketSeconds, 3600);
  assert.equal(queries.at(-1)?.[1], 3600);
  assert.equal(queries.at(-1)?.[2], sessionId);
  await app.close();
});

function emptyDatabase(): Database {
  return {
    async query() {
      return { rows: [] };
    }
  } as unknown as Database;
}

test("admin counters are shared, authorization stays live, and writes invalidate", async () => {
  let configReads = 0;
  let customerReads = 0;
  const db = {
    async query(sql: string) {
      if (sql.includes("WITH usage_by_session")) configReads++;
      if (sql.includes("FROM accounts")) customerReads++;
      return { rows: [] };
    }
  } as unknown as Database;
  const app = Fastify();
  registerAdminBillingRoutes(app, {
    db, billing,
    requireAdmin: async (request, reply) => {
      if (request.headers["x-fixture-admin"] === "yes") return { kind: "admin", id: "fixture" };
      reply.code(403).send({ error: "forbidden" });
      return null;
    }
  });
  app.patch("/v1/admin/billing/fixture-write", async () => ({ ok: true }));
  app.post("/v1/public/sessions/:id/revoke", async () => ({ ok: true }));
  const request = { method: "GET" as const, url: "/v1/admin/billing/customers", headers: { "x-fixture-admin": "yes" } };
  await Promise.all([app.inject(request), app.inject(request)]);
  assert.equal(configReads, 1);
  assert.equal(customerReads, 2, "balances are not cached");
  const denied = await app.inject({ method: "GET", url: request.url });
  assert.equal(denied.statusCode, 403);
  assert.equal(configReads, 1);
  await app.inject({ method: "PATCH", url: "/v1/admin/billing/fixture-write" });
  await app.inject(request);
  assert.equal(configReads, 2);
  await app.inject({ method: "POST", url: "/v1/public/sessions/fixture/revoke" });
  await app.inject(request);
  assert.equal(configReads, 3);
  await app.close();
});

test("traffic caches are scoped by both range and config filter", async () => {
  let reads = 0;
  const db = { async query() { reads++; return { rows: [] }; } } as unknown as Database;
  const app = Fastify();
  registerAdminBillingRoutes(app, { db, billing, requireAdmin: async () => ({ kind: "admin", id: "fixture" }) });
  for (const url of [
    "/v1/admin/billing/traffic?range=24h",
    "/v1/admin/billing/traffic?range=24h",
    "/v1/admin/billing/traffic?range=7d",
    "/v1/admin/billing/traffic?range=24h&sessionId=90386aa8-73e5-4fe0-82c2-8b442e3ad47d"
  ]) assert.equal((await app.inject({ method: "GET", url })).statusCode, 200);
  assert.equal(reads, 3);
  await app.close();
});
