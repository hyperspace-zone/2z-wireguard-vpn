import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "@hyperspace-zone/db";
import { attachMeasurementStore, type MeasurementStore } from "@hyperspace-zone/control-plane";
import { cleanupProbesHistory } from "./retention.js";

for (const mongo of [false, true]) {
  test(`retention cleans bounded job journals and uses ${mongo ? "Mongo TTL" : "SQL history retention"}`, async () => {
    const statements: string[] = [];
    const db = { transaction: async (fn: (client: unknown) => Promise<unknown>) =>
      fn({ query: async (sql: string) => { statements.push(sql); return { rows: [] }; } }) } as unknown as Database;
    if (mongo) attachMeasurementStore(db, {} as MeasurementStore);
    await cleanupProbesHistory(db);
    const jobs = statements.filter(sql => /DELETE FROM (trading_probe_jobs|jobs) WHERE/.test(sql));
    assert.equal(jobs.length, 2);
    for (const sql of jobs) assert.match(sql, /LIMIT 1000 FOR UPDATE SKIP LOCKED/);
    assert.equal(statements.some(sql => sql.includes("DELETE FROM gate_benchmark_results")), !mongo);
    assert.equal(statements.some(sql => sql.includes("DELETE FROM trading_latency_rollups")), !mongo);
    assert.doesNotMatch(statements.join("\n"), /measurement_delivery_outbox|users|sessions|payments|TRUNCATE/);
  });
}
