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
  configPriceLamports: 100_000_000,
  configTrafficLimitBytes: 50_000_000_000,
  configPaymentEnabled: true
};

const treasuryAddress = "DWAg34bbga73yiCh1ic9KLAv3B7FDk62GmUcamXF2Ds8";

test("optional inventory warmup failure does not prevent startup or bypass access checks", async () => {
  const db = { async query() { throw new Error("private database failure"); } } as unknown as Database;
  const app = Fastify();
  registerAdminBillingRoutes(app, { db, billing, requireAdmin: async (_request, reply) => {
    reply.code(403).send({ error: "forbidden" }); return null;
  } });
  await app.ready();
  const response = await app.inject("/v1/admin/billing/customers");
  assert.equal(response.statusCode, 403);
  assert.doesNotMatch(response.body, /private database/);
  await app.close();
});

test("overview counts all customer accounts without reading personal balances and keeps authorization live", async () => {
  let countReads = 0;
  let balanceReads = 0;
  const db = { async query(sql: string) {
    if (sql.includes("COUNT(DISTINCT account_id)")) { countReads++; return { rows: [{ count: 3054 }] }; }
    if (sql.includes("WITH recent_accounts")) balanceReads++;
    return { rows: [] };
  } } as unknown as Database;
  const app = Fastify();
  registerAdminBillingRoutes(app, { db, billing, requireAdmin: async (request, reply) => {
    if (request.headers["x-fixture-admin"] === "yes") return { kind: "admin", id: "fixture" };
    reply.code(403).send({ error: "forbidden" }); return null;
  } });
  const url = "/v1/admin/billing/customers?customers=count&treasury=deferred";
  assert.equal((await app.inject(url)).statusCode, 403);
  assert.equal(countReads, 0);
  for (let i = 0; i < 2; i++) {
    const response = await app.inject({ url, headers: { "x-fixture-admin": "yes" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().customerCount, 3054);
    assert.deepEqual(response.json().customers, []);
    assert.match(String(response.headers["server-timing"]), /customers;dur=/);
  }
  assert.equal(countReads, 2, "customer count is read fresh");
  assert.equal(balanceReads, 0);
  await app.inject({ url: "/v1/admin/billing/customers", headers: { "x-fixture-admin": "yes" } });
  assert.equal(balanceReads, 1, "legacy inventory still includes personal balances");
  await app.close();
});

test("deferred admin inventory does not await treasury RPC; treasury remains live and authorized", async () => {
  let calls = 0;
  const app = Fastify();
  registerAdminBillingRoutes(app, { db: emptyDatabase(), billing,
    treasury: { address: treasuryAddress, readBalance: async () => { calls++; return 123n; } },
    requireAdmin: async (request, reply) => {
      if (request.headers["x-fixture-admin"] === "yes") return { kind: "admin", id: "fixture" };
      reply.code(403).send({ error: "forbidden" }); return null;
    }
  });
  const headers = { "x-fixture-admin": "yes" };
  assert.equal((await app.inject({ url: "/v1/admin/billing/customers?treasury=deferred", headers })).json().treasury.status, "loading");
  assert.equal(calls, 0);
  assert.equal((await app.inject("/v1/admin/billing/treasury")).statusCode, 403);
  assert.equal(calls, 0);
  for (let i = 0; i < 2; i++) {
    const response = await app.inject({ url: "/v1/admin/billing/treasury", headers });
    assert.equal(response.json().balanceBaseUnits, "123");
  }
  assert.equal(calls, 2, "treasury display balances are not cached");
  await app.close();
});

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
    configPriceBaseUnits: "100000000",
    configTrafficLimitBytes: "50000000000"
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

test("billing admin quota route validates whole GB limits", async () => {
  const app = Fastify();
  registerAdminBillingRoutes(app, {
    db: emptyDatabase(),
    billing,
    requireAdmin: async () => ({ kind: "admin", id: "admin-1" })
  });
  const sessionId = "90386aa8-73e5-4fe0-82c2-8b442e3ad47d";

  const fractional = await app.inject({
    method: "PATCH",
    url: `/v1/admin/billing/configs/${sessionId}/traffic-quota`,
    payload: { includedGb: "50.5" }
  });
  assert.equal(fractional.statusCode, 400);

  const excessive = await app.inject({
    method: "PATCH",
    url: `/v1/admin/billing/configs/${sessionId}/traffic-quota`,
    payload: { includedGb: "1000001" }
  });
  assert.equal(excessive.statusCode, 400);
  await app.close();
});

test("billing admin quota route applies an exact large decimal-GB allowance", async () => {
  const sessionId = "90386aa8-73e5-4fe0-82c2-8b442e3ad47d";
  const db = meteredDatabase(sessionId);
  const app = Fastify();
  registerAdminBillingRoutes(app, {
    db,
    billing,
    requireAdmin: async () => ({ kind: "admin", id: "00000000-0000-4000-8000-000000000001" })
  });

  const response = await app.inject({
    method: "PATCH",
    url: `/v1/admin/billing/configs/${sessionId}/traffic-quota`,
    payload: { includedGb: "1000000", reason: "Approved high-volume customer" }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().includedBytes, "1000000000000000");
  assert.equal(response.json().remainingBytes, "999998800000000");
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
  const db = { async query(sql: string) { if (sql.includes("FROM gate_assignment_usage_deltas")) reads++; return { rows: [] }; } } as unknown as Database;
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

function meteredDatabase(sessionId: string): Database {
  const client = {
    async query<Row extends object>(sql: string) {
      if (/JOIN session_traffic_entitlements/.test(sql) && /FOR UPDATE OF sessions/.test(sql)) {
        return {
          rows: [{
            sessionId,
            accountId: "00000000-0000-4000-8000-000000000002",
            includedBytes: "50000000000",
            consumedBytes: "1200000000",
            exhaustedAt: null,
            desiredState: "Active",
            phase: "active",
            generation: 1,
            quotaRevoked: false
          } as Row],
          rowCount: 1
        };
      }
      return { rows: [] as Row[], rowCount: 1 };
    }
  };
  return {
    query: client.query.bind(client),
    async transaction<T>(fn: (transactionClient: typeof client) => Promise<T>) {
      return fn(client);
    }
  } as unknown as Database;
}
