import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable, TransactionalQueryable } from "../../db/queryable.js";
import { adjustSessionTrafficQuota } from "./admin-traffic-quota.scenario.js";

const sessionId = "90386aa8-73e5-4fe0-82c2-8b442e3ad47d";

test("admin traffic quota adjustment updates an active config and records an audit event", async () => {
  const { db, calls } = fakeDatabase({ desiredState: "Active", phase: "active", quotaRevoked: false });
  const result = await adjustSessionTrafficQuota(db, {
    sessionId,
    includedBytes: 500_000_000_000n,
    adminId: "00000000-0000-4000-8000-000000000001",
    reason: "Customer requested 500 GB"
  });

  assert.deepEqual(result, {
    status: "updated",
    sessionId,
    includedBytes: "500000000000",
    consumedBytes: "1200000000",
    remainingBytes: "498800000000",
    reactivation: "not_needed"
  });
  const entitlementUpdate = calls.find((call) => /UPDATE session_traffic_entitlements/.test(call.sql));
  assert.deepEqual(entitlementUpdate?.params, [sessionId, "500000000000", true]);
  const audit = calls.find((call) => /session_traffic_quota_adjusted/.test(call.sql));
  assert.equal(audit?.params?.[0], "00000000-0000-4000-8000-000000000001");
  assert.match(String(audit?.params?.[3]), /Customer requested 500 GB/);
});

test("increasing a quota-revoked config requests reprovisioning", async () => {
  const { db, calls } = fakeDatabase({ desiredState: "Revoked", phase: "revoked", quotaRevoked: true });
  const result = await adjustSessionTrafficQuota(db, {
    sessionId,
    includedBytes: 1_000_000_000_000n,
    adminId: "00000000-0000-4000-8000-000000000001",
    reason: "Restore customer config"
  });

  assert.equal(result.status, "updated");
  if (result.status === "updated") assert.equal(result.reactivation, "requested");
  const desiredState = calls.find((call) => /UPDATE sessions\s+SET desired_state/.test(call.sql));
  assert.deepEqual(desiredState?.params, [sessionId, "Active", true]);
  const status = calls.find((call) => /UPDATE session_status\s+SET phase/.test(call.sql));
  assert.equal(status?.params?.[1], "scheduling");
  assert(calls.some((call) => /QuotaIncreased/.test(String(call.params))));
});

test("quota cannot be reduced to the amount already consumed", async () => {
  const { db, calls } = fakeDatabase({ desiredState: "Active", phase: "active", quotaRevoked: false });
  const result = await adjustSessionTrafficQuota(db, {
    sessionId,
    includedBytes: 1_200_000_000n,
    adminId: "00000000-0000-4000-8000-000000000001",
    reason: "Invalid reduction"
  });

  assert.deepEqual(result, { status: "below_consumed", consumedBytes: "1200000000" });
  assert.equal(calls.some((call) => /UPDATE session_traffic_entitlements/.test(call.sql)), false);
});

function fakeDatabase(state: {
  desiredState: string;
  phase: string;
  quotaRevoked: boolean;
}): { db: TransactionalQueryable; calls: Array<{ sql: string; params: readonly unknown[] | undefined }> } {
  const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  const client: Queryable = {
    async query<Row extends object>(sql: string, params?: readonly unknown[]) {
      calls.push({ sql, params });
      if (/JOIN session_traffic_entitlements/.test(sql) && /FOR UPDATE OF sessions/.test(sql)) {
        return {
          rows: [{
            sessionId,
            accountId: "00000000-0000-4000-8000-000000000002",
            includedBytes: "50000000000",
            consumedBytes: "1200000000",
            exhaustedAt: state.quotaRevoked ? "2026-09-10T12:00:00.000Z" : null,
            desiredState: state.desiredState,
            phase: state.phase,
            generation: 2,
            quotaRevoked: state.quotaRevoked
          } as Row],
          rowCount: 1
        };
      }
      return { rows: [] as Row[], rowCount: 1 };
    }
  };
  return {
    calls,
    db: {
      query: client.query.bind(client),
      async transaction<T>(fn: (transactionClient: Queryable) => Promise<T>) {
        return fn(client);
      }
    }
  };
}
