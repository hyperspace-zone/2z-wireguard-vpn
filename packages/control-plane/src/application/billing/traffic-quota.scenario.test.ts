import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable, TransactionalQueryable } from "../../db/queryable.js";
import { enforceSessionTrafficQuotas } from "./traffic-quota.scenario.js";

test("traffic quota enforcement revokes an exhausted config once and queues email", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  let entitlementReads = 0;
  const client: Queryable = {
    async query<Row extends object>(sql: string, params?: readonly unknown[]) {
      calls.push({ sql, params });
      if (/FROM session_traffic_entitlements/.test(sql) && /FOR UPDATE OF/.test(sql)) {
        entitlementReads += 1;
        return {
          rows: entitlementReads === 1 ? [{
            sessionId: "session-1",
            accountId: "account-1",
            sessionLabel: "customer-route",
            includedBytes: "50000000000",
            consumedBytes: "50000000042",
            phase: "active"
          } as Row] : [],
          rowCount: entitlementReads === 1 ? 1 : 0
        };
      }
      if (/SELECT sessions\.id, session_status\.phase/.test(sql)) {
        return { rows: [{ id: "session-1", phase: "active" } as Row], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  const db: TransactionalQueryable = {
    query: client.query.bind(client),
    async transaction<T>(fn: (transactionClient: Queryable) => Promise<T>) {
      return fn(client);
    }
  };

  const result = await enforceSessionTrafficQuotas(db, 10);

  assert.deepEqual(result, { exhausted: 1, revocationsRequested: 1 });
  const desiredState = calls.find((call) => /UPDATE sessions\s+SET desired_state/.test(call.sql));
  assert.deepEqual(desiredState?.params, ["session-1", "Revoked", true]);
  assert(calls.some((call) => /UPDATE session_traffic_entitlements/.test(call.sql)));
  const notification = calls.find((call) => /INSERT INTO billing_notification_outbox/.test(call.sql));
  assert.equal(notification?.params?.[1], "traffic_quota_exhausted");
  assert.equal(notification?.params?.[2], "traffic-quota-exhausted:session-1");
});

test("traffic quota enforcement is a no-op without exhausted configs", async () => {
  const db: TransactionalQueryable = {
    async query<Row extends object>() {
      return { rows: [] as Row[], rowCount: 0 };
    },
    async transaction<T>(fn: (client: Queryable) => Promise<T>) {
      return fn(this);
    }
  };

  assert.deepEqual(await enforceSessionTrafficQuotas(db), { exhausted: 0, revocationsRequested: 0 });
});
