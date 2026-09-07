import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable } from "../../db/queryable.js";
import { claimTradingProbeJob, cleanupTradingProbeHistory, scheduleTradingProbeJobs } from "./service.js";

test("trading scheduler is disabled without touching PostgreSQL", async () => {
  let queried = false;
  const db = {
    query: async () => {
      queried = true;
      return { rows: [] };
    }
  } as Queryable;
  assert.equal(await scheduleTradingProbeJobs(db, false), 0);
  assert.equal(queried, false);
});

test("history cleanup is bounded and keeps the existing retention windows", async () => {
  const statements: string[] = [];
  const db = { query: async (sql: string) => { statements.push(sql); return { rows: [], rowCount: 0 }; } } as Queryable;
  assert.deepEqual(await cleanupTradingProbeHistory(db), { jobsDeleted: 0, rollupsDeleted: 0 });
  assert.equal(statements.length, 2);
  for (const sql of statements) {
    assert.match(sql, /LIMIT 1000/);
    assert.match(sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(sql, /USING expired/);
  }
  assert.match(statements[0]!, /interval '7 days'/);
  assert.match(statements[0]!, /phase IN \('succeeded', 'failed', 'dead'\)/);
  assert.match(statements[1]!, /interval '90 days'/);
  assert.doesNotMatch(statements.join("\n"), /DELETE FROM sessions/);
});

test("trading scheduler requeues expired leases and uses an independent queue", async () => {
  const statements: string[] = [];
  const db = {
    query: async (sql: string) => {
      statements.push(sql);
      return statements.length === 2 ? { rows: [{ id: "job-1" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
  } as Queryable;
  assert.equal(await scheduleTradingProbeJobs(db, true), 1);
  assert.equal(statements.length, 2);
  assert.match(statements[0] ?? "", /UPDATE trading_probe_jobs/);
  assert.match(statements[0] ?? "", /retry_count >= max_retries/);
  assert.match(statements[1] ?? "", /INSERT INTO trading_probe_jobs/);
  assert.match(statements[1] ?? "", /trading_probe_leases/);
  assert.match(statements[1] ?? "", /trading_latency_latest/);
  assert.doesNotMatch(statements.join("\n"), /\bINSERT INTO jobs\b/);
});

test("trading probe claims oldest queued work before catalog display order", async () => {
  const statements: string[] = [];
  const db = {
    query: async () => ({ rows: [] }),
    transaction: async <T>(fn: (client: Queryable) => Promise<T>) => fn({
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: [] };
      }
    })
  };

  const job = await claimTradingProbeJob(db, {
    id: "probe-node-1",
    name: "probe-node-1",
    desiredState: "Enabled",
    generation: 1
  }, "probe-node-1:boot-1");

  assert.equal(job, null);
  assert.equal(statements.length, 1);
  assert.match(
    statements[0] ?? "",
    /ORDER BY jobs\.created_at, targets\.sort_order, jobs\.id/
  );
});
