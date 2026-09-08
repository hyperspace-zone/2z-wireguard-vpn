import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../migrations/0048_history_tables_autovacuum.sql", import.meta.url);

test("all high-volume archive tables use bounded autovacuum thresholds", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const table of [
    "gate_benchmark_results",
    "job_attempts",
    "trading_probe_jobs",
    "trading_probe_job_attempts",
    "trading_latency_rollups",
    "gate_assignment_counter_samples",
    "gate_assignment_usage_deltas"
  ]) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table} SET`));
  }
  assert.match(sql, /autovacuum_vacuum_scale_factor = 0\.01/g);
  assert.match(sql, /autovacuum_analyze_scale_factor = 0\.005/g);
  assert.doesNotMatch(sql, /VACUUM FULL|autovacuum_enabled\s*=\s*false/i);
});
