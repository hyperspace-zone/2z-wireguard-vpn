import assert from "node:assert/strict";
import test from "node:test";
import { WindowLimiter } from "./window-limiter.js";

test("limiter caps memory and does not evict live identities under rotation", () => {
  const limiter = new WindowLimiter(3);
  for (const ip of ["a", "b", "c"]) assert.equal(limiter.consume(ip, 1, 60_000, 1000).allowed, true);
  for (let i = 0; i < 20_000; i++) assert.equal(limiter.consume(`new-${i}`, 1, 60_000, 1000).allowed, false);
  assert.equal(limiter.size, 3);
  assert.equal(limiter.consume("a", 1, 60_000, 1000).allowed, false);
  assert.equal(limiter.consume("new", 1, 60_000, 61_001).allowed, true);
  assert.equal(limiter.size, 1);
});
test("window resets and rejection counters saturate instead of overflowing", () => {
  const limiter = new WindowLimiter();
  assert.deepEqual(limiter.consume("ip", 1, 1000, 1000), { allowed: true, remaining: 0, resetAt: 2000 });
  assert.equal(limiter.consume("ip", 1, 1000, 1100).allowed, false);
  assert.equal(limiter.consume("ip", 1, 1000, 2000).allowed, true);
});
