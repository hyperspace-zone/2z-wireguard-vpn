import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "@hyperspace-zone/db";
import { registerPublicTradingRoutes } from "./trading.routes.js";

test("selected endpoint reads use the page pool, while full legacy reads keep the benchmark pool", async () => {
  let pageReads = 0, benchmarkReads = 0;
  const pageDb = { query: async () => { pageReads++; return { rows: [] }; } } as unknown as Database;
  const db = { query: async () => { benchmarkReads++; return { rows: [] }; } } as unknown as Database;
  const app = Fastify(); registerPublicTradingRoutes(app, { db, pageDb });
  assert.equal((await app.inject("/v1/public/trading/latency?category=cex&target=default")).statusCode, 200);
  assert.equal(pageReads, 3);
  assert.equal(benchmarkReads, 0);
  assert.equal((await app.inject("/v1/public/trading/latency")).statusCode, 200);
  assert.equal(benchmarkReads, 3);
  assert.equal(pageReads, 3);
  await app.close();
});

test("trading latency category is parameterized and filters both targets and measurements", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = { query: async (sql: string, params: unknown[] = []) => { queries.push({ sql, params }); return { rows: [] }; } } as unknown as Database;
  const app = Fastify(); registerPublicTradingRoutes(app, { db });
  assert.equal((await app.inject("/v1/public/trading/latency?category=hyperliquid")).statusCode, 200);
  assert.deepEqual(queries.filter(q => q.params.length).map(q => q.params), [["hyperliquid"], ["hyperliquid", null]]);
  assert.match(queries.find(q => q.sql.includes("FROM trading_latency_latest"))!.sql, /category = \$1/);
  assert.equal((await app.inject("/v1/public/trading/latency?category=%27%3Bdrop")).statusCode, 400);
  queries.length = 0;
  assert.equal((await app.inject("/v1/public/trading/latency?category=cex&target=default")).statusCode, 200);
  assert.deepEqual(queries.filter(q => q.params.length).map(q => q.params), [["cex"], ["cex", "default"]]);
  assert.match(queries.find(q => q.sql.includes("FROM trading_latency_latest"))!.sql, /ORDER BY \(target_key = \$2\) DESC/);
  await app.close();
});

test("cold database failure returns retryable 503 without cacheable errors or SQL details", async () => {
  const db = { query: async () => { throw Object.assign(new Error("private database detail"), { code: "57014" }); } } as unknown as Database;
  const app = Fastify(); registerPublicTradingRoutes(app, { db });
  try {
    const response = await app.inject("/v1/public/trading/pairs");
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["retry-after"], "2");
    assert.equal(response.json().error, "trading_snapshot_unavailable");
    assert.doesNotMatch(response.body, /private database detail|57014/);
  } finally { await app.close(); }
});

test("background priming publishes a snapshot and preset lookup revalidates outside the display cache", async () => {
  let calls = 0; let fail = false;
  const db = { query: async () => { calls++; if (fail) throw new Error("test outage"); return { rows: [] }; } } as unknown as Database;
  const app = Fastify(); registerPublicTradingRoutes(app, { db, backgroundRefresh: true });
  try {
    const first = await app.inject("/v1/public/trading/pairs");
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().snapshotStatus, "live");
    const before = calls;
    assert.equal((await app.inject("/v1/public/trading/pairs")).statusCode, 200);
    assert.equal(calls, before);
    fail = true;
    const preset = await app.inject(`/v1/public/trading/routes/${"a".repeat(64)}`);
    assert.equal(preset.statusCode, 503, "A live lookup failure must not resolve from the cached display snapshot");
    assert.ok(calls > before);
  } finally { await app.close(); }
});
