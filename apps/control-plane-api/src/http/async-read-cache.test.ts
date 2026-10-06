import assert from "node:assert/strict";
import test from "node:test";
import { createAsyncReadCache } from "./async-read-cache.js";

test("cache shares in-flight queries and expires from completion", async () => {
  let now = 0;
  let calls = 0;
  let resolve!: (value: number) => void;
  const cache = createAsyncReadCache<number>(15, 2, () => now);
  const load = () => { calls++; return new Promise<number>((r) => { resolve = r; }); };
  const first = cache.get("counters", load);
  await Promise.resolve();
  now = 100;
  assert.equal(cache.get("counters", load), first);
  resolve(7);
  assert.equal(await first, 7);
  assert.equal(await cache.get("counters", load), 7);
  assert.equal(calls, 1);
  now = 116;
  assert.equal(await cache.get("counters", async () => 8), 8);
});

test("errors and invalidated pending reads do not repopulate the cache", async () => {
  const cache = createAsyncReadCache<number>(1000);
  await assert.rejects(cache.get("error", async () => { throw new Error("unavailable"); }));
  assert.equal(await cache.get("error", async () => 9), 9);
  let resolve!: (value: number) => void;
  const old = cache.get("pending", () => new Promise<number>((r) => { resolve = r; }));
  await Promise.resolve();
  cache.clear();
  resolve(1);
  await old;
  assert.equal(await cache.get("pending", async () => 2), 2);
});

test("filtered traffic cache has a bounded entry count", async () => {
  const cache = createAsyncReadCache<number>(1000, 2);
  await cache.get("a", async () => 1);
  await cache.get("b", async () => 2);
  await cache.get("c", async () => 3);
  assert.equal(await cache.get("a", async () => 4), 4);
});
