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
  assert.doesNotMatch(migration, /DELETE FROM|DROP |UPDATE jobs/);
});
