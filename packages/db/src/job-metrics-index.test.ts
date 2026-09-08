import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("job metrics use a compact covering index with a nonblocking rollout path", async () => {
  const root = new URL("../../../", import.meta.url);
  const migration = await readFile(new URL("packages/db/migrations/0042_job_metrics_index.sql", root), "utf8");
  const rollout = await readFile(new URL("scripts/control-plane/prebuild-metrics-indexes.mjs", root), "utf8");
  assert.match(migration, /CREATE INDEX IF NOT EXISTS jobs_metrics_type_phase_idx ON jobs \(type, phase\)/);
  assert.match(migration, /AND NOT indisvalid/);
  assert.match(rollout, /CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_metrics_type_phase_idx ON jobs \(type, phase\)/);
  assert.match(rollout, /indisvalid === false/);
  assert.match(rollout, /VACUUM \(ANALYZE, TRUNCATE FALSE\) jobs/);
  assert.doesNotMatch(migration, /DELETE FROM|DROP |UPDATE jobs/);
  const tuning = await readFile(new URL("packages/db/migrations/0043_job_metrics_autovacuum.sql", root), "utf8");
  assert.match(tuning, /autovacuum_vacuum_insert_scale_factor/);
  assert.match(tuning, /options.option_value::numeric <= target_scale/, "Preserve stricter existing thresholds");
  assert.doesNotMatch(tuning, /DELETE FROM|DROP |UPDATE jobs/);
});

test("operational metrics index excludes successful history without deleting jobs", async () => {
  const root = new URL("../../../", import.meta.url);
  const migration = await readFile(new URL("packages/db/migrations/0044_actionable_job_metrics_index.sql", root), "utf8");
  const script = await readFile(new URL("scripts/control-plane/prebuild-active-job-metrics-index.mjs", root), "utf8");
  assert.match(migration, /ON jobs \(type, phase\)\s+WHERE phase <> 'succeeded'/);
  assert.match(script, /CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_actionable_metrics_idx/);
  assert.doesNotMatch(migration, /DELETE FROM|DROP |UPDATE jobs/);
});
