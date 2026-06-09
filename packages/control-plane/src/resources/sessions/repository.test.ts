import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable } from "../../db/queryable.js";
import { listSessionsReadyForCommit } from "./repository.js";

test("sessions ready for commit ignore already succeeded commit jobs", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  const db: Queryable = {
    async query<Row extends object>(sql: string, params?: readonly unknown[]) {
      calls.push({ sql, params });
      return { rows: [] as Row[], rowCount: 0 };
    }
  };

  await listSessionsReadyForCommit(db);

  assert.equal(calls.length, 1);
  const [query] = calls;
  assert.ok(query);
  assert.match(query.sql, /jobs\.payload->>'operation'\s+=\s+'commit'/);
  assert.match(query.sql, /jobs\.phase IN \('queued', 'leased', 'running', 'retryable_failed', 'succeeded'\)/);
});
