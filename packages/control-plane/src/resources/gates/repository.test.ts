import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable } from "../../db/queryable.js";
import { readGateAgentRuntime, saveGateHeartbeatStatus } from "./repository.js";

const heartbeat = {
  gateId: "00000000-0000-0000-0000-000000000001",
  generation: 1,
  agentVersion: "0.1.0",
  agentRevision: "0123456789abcdef",
  agentBuiltAt: "2026-08-19T06:00:00Z",
  agentArtifactSha256: "a".repeat(64),
  agentInstalledAt: "2026-08-19T06:10:00Z",
  bootId: "boot-id",
  observedEndpoint: "203.0.113.10",
  capabilities: ["doublezero0:up"],
  clockErrorMs: 1,
  doubleZeroStatus: {
    tunnelStatus: "BGP Session Down",
    network: "mainnet-beta",
    metro: "London",
    currentDevice: "lon-dz001"
  },
  doubleZeroCurrentDevice: "lon-dz001",
  doubleZeroLowestLatencyDevice: "lon-dz001",
  doubleZeroLowestLatencyDeviceWarning: false,
  conditions: []
};

test("gate heartbeat records a DoubleZero BGP status transition as an audit event", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db: Queryable = {
    async query<Row extends object>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      if (/SELECT NULLIF\(BTRIM\(doublezero_status/.test(sql)) {
        return { rows: [{ tunnelStatus: "BGP Session Up" }] as Row[], rowCount: 1 };
      }
      return { rows: [] as Row[], rowCount: 1 };
    }
  };

  await saveGateHeartbeatStatus(db, heartbeat);

  const upsert = calls.find((call) => call.sql.includes("INSERT INTO gate_status"));
  assert.ok(upsert);
  assert.match(upsert.sql, /agent_revision/);
  assert.match(upsert.sql, /agent_installed_at/);
  assert.equal(upsert.params[3], heartbeat.agentRevision);
  assert.equal(upsert.params[5], heartbeat.agentArtifactSha256);

  const audit = calls.find((call) => call.sql.includes("gate_doublezero_tunnel_status_changed"));
  assert.ok(audit);
  assert.equal(audit.params[0], heartbeat.gateId);
  assert.deepEqual(JSON.parse(String(audit.params[1])), {
    previousStatus: "BGP Session Up",
    currentStatus: "BGP Session Down",
    network: "mainnet-beta",
    metro: "London",
    currentDevice: "lon-dz001"
  });
});

test("gate runtime exposes the exact observed artifact and deployment dates", async () => {
  const row = {
    agentVersion: "0.2.2",
    agentRevision: "0123456789abcdef",
    agentBuiltAt: "2026-08-19T06:00:00Z",
    agentArtifactSha256: "b".repeat(64),
    agentInstalledAt: "2026-08-19T06:10:00Z",
    lastSeenAt: "2026-08-19T06:11:00Z"
  };
  const db: Queryable = {
    async query<Row extends object>() {
      return { rows: [row] as Row[], rowCount: 1 };
    }
  };

  assert.deepEqual(await readGateAgentRuntime(db, heartbeat.gateId), row);
});

test("gate heartbeat does not duplicate an audit event while BGP status is unchanged", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db: Queryable = {
    async query<Row extends object>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      if (/SELECT NULLIF\(BTRIM\(doublezero_status/.test(sql)) {
        return { rows: [{ tunnelStatus: "BGP Session Down" }] as Row[], rowCount: 1 };
      }
      return { rows: [] as Row[], rowCount: 1 };
    }
  };

  await saveGateHeartbeatStatus(db, heartbeat);

  assert.equal(calls.some((call) => call.sql.includes("gate_doublezero_tunnel_status_changed")), false);
});
