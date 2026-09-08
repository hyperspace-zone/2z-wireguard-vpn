import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const scriptUrl = new URL("./hyperspace-pg-history-archive", import.meta.url);
const script = readFileSync(scriptUrl, "utf8");
const migration = readFileSync(
  new URL("../../packages/db/migrations/0045_history_archive_indexes.sql", import.meta.url),
  "utf8"
);

test("history archive shell is syntactically valid and fail-closed", () => {
  execFileSync("bash", ["-n", scriptUrl.pathname]);
  assert.match(script, /must be an exact NFS\/NFSv4 mount/);
  assert.match(script, /zstd --quiet --test/);
  assert.match(script, /archive row count mismatch/);
  assert.ok(script.indexOf('>"${output_dir}\/READY"') < script.indexOf("delete_archived_day"));
  assert.match(script, /LIMIT \$\{delete_batch_size\} FOR UPDATE SKIP LOCKED/);
  assert.match(script, /sleep "\$delete_sleep_seconds"/);
  assert.doesNotMatch(script, /if process_dataset_day/);
  assert.doesNotMatch(script, /VACUUM FULL|TRUNCATE/);
});

test("history archive indexes cover time scans and the benchmark job foreign key", () => {
  assert.match(migration, /jobs_history_archive_idx[\s\S]*updated_at, id/);
  assert.match(migration, /gate_benchmark_results_history_archive_idx[\s\S]*measured_at, id/);
  assert.match(migration, /gate_benchmark_results_job_id_idx[\s\S]*job_id/);
  assert.match(migration, /gate_assignment_counter_samples_history_archive_idx[\s\S]*sampled_at, id/);
});
