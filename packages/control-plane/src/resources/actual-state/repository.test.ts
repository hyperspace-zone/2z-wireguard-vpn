import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable } from "../../db/queryable.js";
import { listGateActualStateDriftInputs, updateGateActualState } from "./repository.js";

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

test("actual-state updates do not overwrite heartbeat capabilities", async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const db = {
    query: async (text: string, values: unknown[]) => {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    }
  };

  await updateGateActualState(db, "00000000-0000-0000-0000-000000000001", {
    stateHash: "state-hash",
    capabilities: ["actual-state-report"],
    bootId: "boot-id",
    agentVersion: "0.1.0",
    managedHandles: [],
    assignmentCounters: [],
    diagnosticSummary: {},
    reportedAt: "2026-06-17T00:00:00.000Z"
  });

  const updateGateStatusSql = queries.find((query) => query.text.includes("UPDATE gate_status"))?.text ?? "";
  const updateGateStatusValues = queries.find((query) => query.text.includes("UPDATE gate_status"))?.values ?? [];

  assert.match(updateGateStatusSql, /actual_state_hash = \$2/);
  assert.doesNotMatch(updateGateStatusSql, /observed_capabilities\s*=/);
  assert.equal(updateGateStatusValues.length, 4);
});

test("assignment counter persistence is idempotent and derives interval deltas", async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const db = {
    query: async (text: string, values: unknown[]) => {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    }
  };

  await updateGateActualState(db, "00000000-0000-0000-0000-000000000001", {
    stateHash: "state-hash",
    capabilities: [],
    bootId: "boot-id",
    agentVersion: "0.2.0",
    managedHandles: ["hs-assignment-00000000-0000-0000-0000-000000000002"],
    assignmentCounters: [{
      assignmentId: "00000000-0000-0000-0000-000000000002",
      role: "Ingress",
      generation: 1,
      sampledAt: "2026-07-15T12:00:00.000Z",
      wireGuardClientReceiveBytes: 10,
      wireGuardClientTransmitBytes: 20,
      wireGuardTransitReceiveBytes: 30,
      wireGuardTransitTransmitBytes: 40,
      forwardedToDestinationPackets: 1,
      forwardedToDestinationBytes: 100,
      forwardedFromDestinationPackets: 2,
      forwardedFromDestinationBytes: 200,
      droppedToDestinationPackets: 3,
      droppedToDestinationBytes: 300,
      droppedFromDestinationPackets: 4,
      droppedFromDestinationBytes: 400
    }],
    diagnosticSummary: {},
    reportedAt: "2026-07-15T12:00:00.000Z"
  });

  const counterQuery = queries.find((query) => query.text.includes("INSERT INTO gate_assignment_counter_samples"));
  assert.ok(counterQuery);
  assert.match(counterQuery.text, /ON CONFLICT \(gate_id, assignment_id, boot_id, generation, sampled_at\) DO NOTHING/);
  assert.match(counterQuery.text, /INSERT INTO gate_assignment_usage_deltas/);
  assert.match(counterQuery.text, /GREATEST\(inserted\.forwarded_to_destination_bytes/);
  assert.equal(counterQuery.values.length, 18);
});
