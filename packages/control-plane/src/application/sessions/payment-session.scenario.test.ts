import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable, TransactionalQueryable } from "../../db/queryable.js";
import { activatePaidSession } from "./payment-session.scenario.js";

test("paid session activation uses the session condition transition timestamp", async () => {
  const calls: string[] = [];
  const db: TransactionalQueryable = {
    async query<Row extends object>() {
      assert.fail("activatePaidSession must use the transaction client");
      return { rows: [] as Row[], rowCount: 0 };
    },
    async transaction<T>(fn: (client: Queryable) => Promise<T>) {
      return fn({
        async query<Row extends object>(sql: string) {
          calls.push(sql);
          if (/SELECT session_status\.phase/.test(sql)) {
            return { rows: [{ phase: "payment_pending" } as Row], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        }
      });
    }
  };

  const result = await activatePaidSession(
    db,
    { id: "user-1", accountId: "account-1" },
    "session-1",
    "payment-1",
    "signature-1"
  );

  assert.equal(result, "activated");
  const conditionUpdate = calls.find((sql) => /UPDATE session_conditions/.test(sql));
  assert.match(conditionUpdate ?? "", /last_transition_at = now\(\)/);
  assert.doesNotMatch(conditionUpdate ?? "", /updated_at/);
});
