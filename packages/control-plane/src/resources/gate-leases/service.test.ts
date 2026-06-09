import assert from "node:assert/strict";
import test from "node:test";
import { gateHeartbeatLeaseTtlSeconds, isGateLeaseFresh } from "./service.js";

test("gate lease freshness uses lease expiry as source of truth", () => {
  const now = new Date("2026-06-09T00:00:00Z");
  assert.equal(isGateLeaseFresh(new Date("2026-06-09T00:00:01Z"), now), true);
  assert.equal(isGateLeaseFresh(new Date("2026-06-08T23:59:59Z"), now), false);
});

test("gate heartbeat lease ttl has a safe minimum", () => {
  assert.equal(gateHeartbeatLeaseTtlSeconds(1), 30);
  assert.equal(gateHeartbeatLeaseTtlSeconds(15), 45);
});
