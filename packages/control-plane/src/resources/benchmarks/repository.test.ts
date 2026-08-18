import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable } from "../../db/queryable.js";
import {
  insertDueGateBenchmarkProbeJobs,
  insertDueGateNtpDiscoveryJobs,
  listLatestGateBenchmarkRoutes
} from "./repository.js";

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
  assert.match(call.sql, /pg_try_advisory_xact_lock/);
  assert.match(call.sql, /jobs\.type = 'probe'/);
  assert.match(call.sql, /jobs\.payload->>'kind' = 'gate_benchmark_v1'/);
  assert.match(call.sql, /active_pairs AS MATERIALIZED/);
  assert.match(call.sql, /recent_pairs AS MATERIALIZED/);
  assert.match(call.sql, /LEFT JOIN active_pairs/);
  assert.match(call.sql, /LEFT JOIN recent_pairs/);
  assert.doesNotMatch(call.sql, /WHERE NOT EXISTS/);
  assert.match(call.sql, /jsonb_build_object\('name', 'public', 'interface', 'public'\)/);
  assert.match(call.sql, /jsonb_build_object\('name', 'doublezero', 'interface', source_doublezero_interface\)/);
  assert.match(call.sql, /gate_status\.doublezero_status->>'metro'/);
  assert.match(call.sql, /source_doublezero_metro IS NOT NULL/);
  assert.match(call.sql, /LOWER\(source_doublezero_metro\) = LOWER\(target_doublezero_metro\)/);
  assert.deepEqual(call.params, [300, 19192, 10, 100, 1000]);
});

test("benchmark matrix marks same DoubleZero metro as not applicable and hides old failures", async () => {
  const calls: string[] = [];
  const db: Queryable = {
    async query<Row extends object>(sql: string) {
      calls.push(sql);
      return {
        rows: [{
          sourceGateId: "gate-a-id",
          sourceGateName: "gate-eu-lon-01",
          targetGateId: "gate-b-id",
          targetGateName: "gate-eu-lon-41",
          sameDoubleZeroMetro: true,
          doublezeroMetro: "London",
          publicMetric: {
            transport: "public",
            status: "succeeded",
            measuredAt: "2026-08-17T00:00:00.000Z"
          },
          doublezeroMetric: {
            transport: "doublezero",
            status: "failed",
            errorCode: "no_probe_responses",
            measuredAt: "2026-08-16T00:00:00.000Z"
          }
        }] as Row[],
        rowCount: 1
      };
    }
  };

  const routes = await listLatestGateBenchmarkRoutes(db);

  assert.deepEqual(routes, [{
    sourceGateId: "gate-a-id",
    sourceGateName: "gate-eu-lon-01",
    targetGateId: "gate-b-id",
    targetGateName: "gate-eu-lon-41",
    public: {
      transport: "public",
      status: "succeeded",
      measuredAt: "2026-08-17T00:00:00.000Z"
    },
    doublezeroApplicability: {
      status: "not_applicable",
      reason: "same_doublezero_metro",
      metro: "London"
    }
  }]);
  assert.match(calls[0] ?? "", /LEFT JOIN gate_status source_status/);
  assert.match(calls[0] ?? "", /directed_pairs\.source_doublezero_metro IS NOT NULL/);
  assert.match(calls[0] ?? "", /transport = 'doublezero'/);
});

test("benchmark matrix keeps DoubleZero results when metro is unknown", async () => {
  const db: Queryable = {
    async query<Row extends object>() {
      return {
        rows: [{
          sourceGateId: "gate-a-id",
          sourceGateName: "gate-a",
          targetGateId: "gate-b-id",
          targetGateName: "gate-b",
          sameDoubleZeroMetro: false,
          doublezeroMetro: null,
          publicMetric: null,
          doublezeroMetric: {
            transport: "doublezero",
            status: "succeeded",
            measuredAt: "2026-08-17T00:00:00.000Z"
          }
        }] as Row[],
        rowCount: 1
      };
    }
  };

  const routes = await listLatestGateBenchmarkRoutes(db);

  assert.equal(routes[0]?.doublezero?.status, "succeeded");
  assert.equal(routes[0]?.doublezeroApplicability, undefined);
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
