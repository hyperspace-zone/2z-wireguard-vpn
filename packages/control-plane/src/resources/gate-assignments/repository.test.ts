import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable } from "../../db/queryable.js";
import {
  markAssignmentAppliedFromReport,
  markAssignmentPreparedFromReport,
  markAssignmentRevokedFromReport
} from "./repository.js";

test("successful assignment reports clear stale errors", async () => {
  const calls: string[] = [];
  const db: Queryable = {
    async query<Row extends object>(sql: string) {
      calls.push(sql);
      return { rows: [] as Row[], rowCount: 0 };
    }
  };
  const report = {
    assignmentId: "assignment-1",
    actualStateHash: "state-hash",
    errorCode: "",
    resultSummary: { status: "ok" }
  };

  await markAssignmentPreparedFromReport(db, {
    ...report,
    nextPhase: "prepared",
    material: { role: "Ingress" }
  });
  await markAssignmentAppliedFromReport(db, {
    ...report,
    nextPhase: "applied"
  });
  await markAssignmentRevokedFromReport(db, {
    ...report,
    nextPhase: "revoked"
  });

  assert.equal(calls.length, 3);
  for (const sql of calls) {
    assert.match(sql, /last_error = NULL/);
  }
});
