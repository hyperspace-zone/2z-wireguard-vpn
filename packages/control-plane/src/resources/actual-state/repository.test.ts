import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable } from "../../db/queryable.js";
import { listGateActualStateDriftInputs } from "./repository.js";

test("drift inputs ignore desired handles newer than latest actual snapshot", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  const db: Queryable = {
    async query<Row extends object>(sql: string, params?: readonly unknown[]) {
      calls.push({ sql, params });
      return { rows: [] as Row[], rowCount: 0 };
    }
  };

  await listGateActualStateDriftInputs(db);

  assert.equal(calls.length, 1);
  const [query] = calls;
  assert.ok(query);
  assert.match(query.sql, /gate_assignment_status\.phase IN \('applied', 'drifted'\)/);
  assert.doesNotMatch(query.sql, /'prepared'/);
  assert.match(query.sql, /latest_snapshot\."receivedAt"\s+>=\s+gate_assignment_status\.applied_at/);
});
