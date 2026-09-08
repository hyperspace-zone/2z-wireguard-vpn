import assert from "node:assert/strict";
import test from "node:test";
import { SnapshotCache } from "./snapshot-cache.js";

test("cold visitors share one refresh and healthy reads use the prepared snapshot", async () => {
  let calls = 0;
  let release: (value: string) => void = () => undefined;
  const cache = new SnapshotCache(() => { calls++; return new Promise<string>(resolve => { release = resolve; }); });
  const readers = Array.from({ length: 25 }, () => cache.read());
  await Promise.resolve();
  assert.equal(calls, 1);
  release("snapshot");
  for (const result of await Promise.all(readers)) assert.equal(result.state, "live");
  assert.equal((await cache.read()).data, "snapshot");
  assert.equal(calls, 1);
});

test("expired reads return last-good data immediately while one refresh runs", async () => {
  let now = 0; let calls = 0;
  let release: (value: string) => void = () => undefined;
  const cache = new SnapshotCache(async () => ++calls === 1 ? "first" : new Promise<string>(resolve => { release = resolve; }), () => now);
  await cache.read(); now = 16_000;
  const responses = await Promise.all(Array.from({ length: 20 }, () => cache.read()));
  assert.equal(calls, 2);
  assert.deepEqual(responses[0], { data: "first", state: "refreshing", ageSeconds: 16 });
  const force = cache.fresh(); release("second");
  assert.equal(await force, "second");
  assert.equal((await cache.read()).state, "live");
});

test("refresh failures keep a bounded fallback, back off, and never satisfy forced validation", async () => {
  let now = 0; let calls = 0; let fail = false;
  const cache = new SnapshotCache(async () => { calls++; if (fail) throw new Error("DB timeout"); return "good"; }, () => now);
  await cache.read(); fail = true; now = 16_000;
  await assert.rejects(cache.fresh(), /DB timeout/);
  assert.deepEqual(await cache.read(), { data: "good", state: "stale", ageSeconds: 16 });
  for (let i = 0; i < 10; i++) await cache.read();
  assert.equal(calls, 2, "Visitors must not hammer a failed database");
  await assert.rejects(cache.fresh(), /DB timeout/, "A forced checkout read must not use the last good snapshot");
  now = 121_000;
  await assert.rejects(cache.read(), /DB timeout/, "Never return indefinitely old data");
  fail = false; now = 127_000;
  assert.equal((await cache.read()).state, "live");
});

test("a failed cold refresh is retryable, not retained as a rejected cached promise", async () => {
  let now = 0; let calls = 0;
  const cache = new SnapshotCache(async () => { if (++calls === 1) throw new Error("cold failure"); return "ready"; }, () => now);
  await assert.rejects(cache.read(), /cold failure/);
  await assert.rejects(cache.read(), /temporarily unavailable/);
  assert.equal(calls, 1);
  now = 5000;
  assert.equal((await cache.read()).data, "ready");
});
