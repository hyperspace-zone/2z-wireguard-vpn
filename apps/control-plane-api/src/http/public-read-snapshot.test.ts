import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { PublicReadSnapshot, publicSnapshotHeaders } from "./public-read-snapshot.js";

test("one fixed snapshot shares concurrent cold loads and preserves original timestamps", async () => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const data = { generatedAt: "2026-10-07T08:00:00Z", measuredAt: "2026-10-07T07:59:00Z" };
  const cache = new PublicReadSnapshot("trading", async () => { calls++; await gate; return data; });
  const pending = Array.from({ length: 50 }, () => cache.read());
  await Promise.resolve(); assert.equal(calls, 1); release();
  const values = await Promise.all(pending);
  assert.ok(values.every(v => v.data === data));
  assert.equal((await cache.read()).data.measuredAt, data.measuredAt);
  assert.equal(calls, 1); await cache.close();
});

test("failed refresh is bounded, backed off, visibly stale, and expires rather than becoming fresh", async () => {
  let now = 0, calls = 0, offline = false;
  const cache = new PublicReadSnapshot("benchmarks", async () => { calls++; if (offline) throw new Error("mongodb://secret"); return { generatedAt: "original" }; },
    { now: () => now, freshMs: 10, maxAgeMs: 60, retryMs: 5 });
  assert.equal((await cache.read()).state, "live");
  offline = true; now = 11;
  await assert.rejects(cache.refresh(), /temporarily unavailable/);
  const stale = await cache.read(); assert.equal(stale.state, "stale"); assert.equal(stale.data.generatedAt, "original");
  await Promise.all(Array.from({ length: 50 }, () => cache.read())); assert.equal(calls, 2);
  now = 61; await assert.rejects(cache.read(), /temporarily unavailable/);
  offline = false; now = 70; assert.equal((await cache.read()).state, "live");
  await cache.close();
});

test("oversized snapshot cannot replace bounded last-good data", async () => {
  let large = false;
  const cache = new PublicReadSnapshot("trading", async () => large ? "x".repeat(200) : "ok", { maxBytes: 50 });
  await cache.read(); large = true; await assert.rejects(cache.refresh());
  const result = await cache.read(); assert.equal(result.data, "ok"); assert.equal(result.state, "stale");
  await cache.close();
});

test("ETag/304 only for live data; cookies/auth/stale responses cannot enter a shared cache", async () => {
  const app = Fastify();
  app.get("/snapshot", async (request, reply) => {
    const state = request.headers["x-test-stale"] ? "stale" : "live";
    if (publicSnapshotHeaders(request, reply, { state, ageSeconds: 0, etag: 'W/"test"' })) return reply;
    return { ok: true };
  });
  try {
    const first = await app.inject("/snapshot"); assert.match(String(first.headers["cache-control"]), /s-maxage=5/);
    const cached = await app.inject({ url: "/snapshot", headers: { "if-none-match": 'W/"test"' } });
    assert.equal(cached.statusCode, 304); assert.equal(cached.body, "");
    for (const headers of [{ cookie: "session=private" }, { authorization: "Bearer secret" }, { "x-test-stale": "yes", "if-none-match": 'W/"test"' }]) {
      const response = await app.inject({ url: "/snapshot", headers });
      assert.equal(response.statusCode, 200); assert.equal(response.headers["cache-control"], "no-store");
    }
  } finally { await app.close(); }
});
