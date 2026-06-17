import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable, TransactionalQueryable } from "../../db/queryable.js";
import { createSession } from "./create-session.scenario.js";

test("createSession rejects when account active-session quota is reached", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  const db: TransactionalQueryable = {
    async query<Row extends object>(sql: string, params?: readonly unknown[]) {
      calls.push({ sql, params });
      return queryResponse<Row>(sql);
    },
    async transaction<T>(fn: (client: Queryable) => Promise<T>) {
      return fn({
        async query<Row extends object>(sql: string, params?: readonly unknown[]) {
          calls.push({ sql, params });
          return queryResponse<Row>(sql);
        }
      });
    }
  };

  const result = await createSession(
    db,
    { id: "user-1", accountId: "account-1" },
    {
      mode: "IpToIp",
      targetIp: "1.1.1.1",
      ingressGateName: "gate-a",
      egressGateName: "gate-b"
    },
    {
      maxActiveSessionsPerAccount: 1,
      maxSessionCreatesPerWindow: 100,
      sessionCreateWindowSeconds: 3600
    }
  );

  assert.equal(result.status, "invalid");
  assert.equal(result.error, "session_quota_exceeded");
  assert.ok(calls.some((call) => /FOR UPDATE/.test(call.sql)));
  assert.ok(calls.some((call) => /session_rejected/.test(call.sql)));
  assert.ok(!calls.some((call) => /INSERT INTO sessions/.test(call.sql)));
});

function queryResponse<Row extends object>(sql: string): { rows: Row[]; rowCount: number } {
  if (/SELECT id\s+FROM accounts/.test(sql)) {
    return { rows: [{ id: "account-1" } as Row], rowCount: 1 };
  }
  if (/COUNT\(\*\)::int AS count/.test(sql)) {
    return { rows: [{ count: 1 } as Row], rowCount: 1 };
  }
  if (/INSERT INTO audit_events/.test(sql)) {
    return { rows: [], rowCount: 1 };
  }
  assert.fail(`unexpected SQL: ${sql}`);
}
