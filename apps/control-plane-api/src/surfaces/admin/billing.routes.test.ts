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

test("billing admin overview contains config payments, deposits and asset metadata", async () => {
  const db = emptyDatabase();
  const app = Fastify();
  registerAdminBillingRoutes(app, {
    db,
    billing,
    requireAdmin: async () => ({ kind: "admin", id: "admin-1" })
  });

  const response = await app.inject({ method: "GET", url: "/v1/admin/billing/customers" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.customers, []);
  assert.deepEqual(body.configs, []);
  assert.deepEqual(body.payments, []);
  assert.deepEqual(body.deposits, []);
  assert.deepEqual(body.asset, {
    symbol: "SOL",
    decimals: 9,
    explorerTransactionBaseUrl: "https://orbmarkets.io/tx/",
    configPriceBaseUnits: "100000"
  });
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
