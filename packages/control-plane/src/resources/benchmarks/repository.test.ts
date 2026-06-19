import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable } from "../../db/queryable.js";
import { insertDueGateBenchmarkProbeJobs, insertDueGateNtpDiscoveryJobs } from "./repository.js";

test("benchmark scheduler inserts idempotent directed gate probe jobs", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db: Queryable = {
    async query<Row extends object>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [] as Row[], rowCount: 20 };
    }
  };

  const inserted = await insertDueGateBenchmarkProbeJobs(db, {
    intervalSeconds: 300,
    probePort: 19192,
    probeCount: 10,
    probeIntervalMs: 100,
    probeTimeoutMs: 1000
  });

  assert.equal(inserted, 20);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call);
  assert.match(call.sql, /jobs\.type = 'probe'/);
  assert.match(call.sql, /jobs\.payload->>'kind' = 'gate_benchmark_v1'/);
  assert.match(call.sql, /gate_benchmark_results recent/);
  assert.match(call.sql, /jsonb_build_object\('name', 'public', 'interface', 'public'\)/);
  assert.match(call.sql, /jsonb_build_object\('name', 'doublezero', 'interface', source_doublezero_interface\)/);
  assert.deepEqual(call.params, [300, 19192, 10, 100, 1000]);
});

test("ntp discovery scheduler inserts idempotent gate maintenance probe jobs", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db: Queryable = {
    async query<Row extends object>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [] as Row[], rowCount: 5 };
    }
  };

  const inserted = await insertDueGateNtpDiscoveryJobs(db, {
    intervalSeconds: 86400,
    sampleSeconds: 30,
    maxCandidates: 96
  });

  assert.equal(inserted, 5);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call);
  assert.match(call.sql, /jobs\.type = 'probe'/);
  assert.match(call.sql, /jobs\.payload->>'kind' = 'gate_ntp_discovery_v1'/);
  assert.match(call.sql, /'ntp-discovery:enabled' = ANY\(gate_status\.observed_capabilities\)/);
  assert.match(call.sql, /job_attempts attempts/);
  assert.deepEqual(call.params, [86400, 30, 96]);
});
