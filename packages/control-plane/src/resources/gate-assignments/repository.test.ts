import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable } from "../../db/queryable.js";
import {
  markAssignmentAppliedFromReport,
  markAssignmentPreparedFromReport,
  markAssignmentRevokedFromReport,
  upsertGateAssignment
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

test("assignment upsert advances generation when a revoked config is reprovisioned", async () => {
  let statement = "";
  const db: Queryable = {
    async query<Row extends object>(sql: string) {
      statement = sql;
      return { rows: [{ id: "assignment-1" } as Row], rowCount: 1 };
    }
  };
  await upsertGateAssignment(db, {
    sessionId: "session-1",
    gateId: "gate-1",
    role: "Ingress",
    planId: "plan-2",
    desiredState: "Applied"
  });
  assert.match(statement, /gate_assignments\.generation \+ 1/);
  assert.match(statement, /gate_assignments\.desired_state <> EXCLUDED\.desired_state/);
  assert.match(statement, /gate_assignments\.plan_id <> EXCLUDED\.plan_id/);
});
