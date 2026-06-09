import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable } from "../../db/queryable.js";
import { gateHeartbeatLeaseTtlSeconds } from "./policy.js";
import { isGateLeaseFresh, recordGateLease } from "./service.js";

test("gate lease freshness uses lease expiry as source of truth", () => {
  const now = new Date("2026-06-09T00:00:00Z");
  assert.equal(isGateLeaseFresh(new Date("2026-06-09T00:00:01Z"), now), true);
  assert.equal(isGateLeaseFresh(new Date("2026-06-08T23:59:59Z"), now), false);
});

test("gate heartbeat lease ttl has a safe minimum", () => {
  assert.equal(gateHeartbeatLeaseTtlSeconds(1), 30);
  assert.equal(gateHeartbeatLeaseTtlSeconds(15), 45);
});

test("gate lease service records heartbeat lease with policy ttl", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db: Queryable = {
    async query<Row extends object>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [] as Row[], rowCount: 1 };
    }
  };

  await recordGateLease(db, {
    gateId: "gate-1",
    leaseOwner: "gate-eu-01",
    heartbeatIntervalSeconds: 15
  });

  assert.equal(calls.length, 1);
  const [leaseWrite] = calls;
  assert.ok(leaseWrite);
  assert.match(leaseWrite.sql, /INSERT INTO gate_leases/);
  assert.deepEqual(leaseWrite.params, ["gate-1", "gate-eu-01", 45]);
});
