import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "@hyperspace-zone/db";
import { registerPublicTradingRoutes } from "./trading.routes.js";

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
