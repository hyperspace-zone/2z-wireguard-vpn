import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable } from "../../db/queryable.js";
import { findClaimableGateJobForUpdate, insertApplyAssignmentJob, insertRevokeAssignmentJob } from "./repository.js";

test("gate job claims isolate control work from benchmark probes", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db: Queryable = {
    async query<Row extends object>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [] as Row[], rowCount: 0 };
    }
  };

  await findClaimableGateJobForUpdate(db, "gate-1", "control");
  await findClaimableGateJobForUpdate(db, "gate-1", "probe");
  await findClaimableGateJobForUpdate(db, "gate-1");

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.match(call.sql, /'probe' AND type = 'probe'/);
    assert.match(call.sql, /'control' AND type <> 'probe'/);
  }
  assert.deepEqual(calls.map((call) => call.params), [
    ["gate-1", "control"],
    ["gate-1", "probe"],
    ["gate-1", null]
  ]);
});

test("apply assignment job insert is idempotent across active and succeeded jobs", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db: Queryable = {
    async query<Row extends object>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [] as Row[], rowCount: 0 };
    }
  };

  await insertApplyAssignmentJob(db, {
    assignmentId: "assignment-1",
    gateId: "gate-1",
    sessionId: "session-1",
    operation: "commit",
    role: "Ingress",
    initialPhase: "queued"
  });

  assert.equal(calls.length, 1);
  const [insert] = calls;
  assert.ok(insert);
  assert.match(insert.sql, /phase IN \('queued', 'leased', 'running', 'retryable_failed'\)/);
  assert.match(insert.sql, /jobs\.phase = 'succeeded'/);
  assert.match(insert.sql, /JOIN gate_assignment_status/);
  assert.match(insert.sql, /gate_assignment_status\.phase IN \('queued', 'leased', 'applying', 'prepared', 'applied'\)/);
});

test("revoke assignment job insert is idempotent after a succeeded revoke", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db: Queryable = {
    async query<Row extends object>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [] as Row[], rowCount: 0 };
    }
  };

  await insertRevokeAssignmentJob(db, {
    assignmentId: "assignment-1",
    gateId: "gate-1",
    sessionId: "session-1",
    role: "Egress",
    initialPhase: "queued"
  });

  assert.equal(calls.length, 1);
  const [insert] = calls;
  assert.ok(insert);
  assert.match(insert.sql, /phase IN \('queued', 'leased', 'running', 'retryable_failed'\)/);
  assert.match(insert.sql, /phase = 'succeeded'/);
});
