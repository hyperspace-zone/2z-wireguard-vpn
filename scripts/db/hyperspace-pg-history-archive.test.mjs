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
const directTimeMigration = readFileSync(
  new URL("../../packages/db/migrations/0047_history_archive_direct_time_indexes.sql", import.meta.url),
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
  assert.match(script, /max_parallel_workers_per_gather=0/);
  assert.match(script, /enable_seqscan=off/);
  assert.match(script, /COPY \(SELECT row_to_json\(archive_row\)::text/);
  assert.match(script, /DELIMITER E'\\\\t', QUOTE E'\\\\x01'/);
  assert.match(script, /renice 15/);
  assert.match(script, /kill -0 "\$query_pid"/);
  assert.match(
    script,
    /datasets=\(gate_benchmarks job_attempts jobs trading_attempts trading_jobs trading_rollups assignment_deltas assignment_samples\)/
  );
  assert.doesNotMatch(script, /job_id IN \(SELECT id FROM (?:jobs|trading_probe_jobs)/);
  assert.match(script, /assignment_deltas\) printf '%s' 'gate_assignment_usage_deltas created_at sample_id'/);
  assert.doesNotMatch(script, /if process_dataset_day/);
  assert.doesNotMatch(script, /VACUUM FULL|TRUNCATE/);
});

test("history archive indexes cover time scans and the benchmark job foreign key", () => {
  assert.match(migration, /jobs_history_archive_idx[\s\S]*updated_at, id/);
  assert.match(migration, /gate_benchmark_results_created_history_archive_idx[\s\S]*created_at, id/);
  assert.match(migration, /gate_benchmark_results_job_id_idx[\s\S]*job_id/);
  assert.match(migration, /gate_assignment_counter_samples_history_archive_idx[\s\S]*received_at, id/);
  assert.match(directTimeMigration, /job_attempts_completed_history_archive_idx[\s\S]*completed_at, id/);
  assert.match(
    directTimeMigration,
    /trading_probe_job_attempts_completed_history_archive_idx[\s\S]*completed_at, id/
  );
  assert.match(directTimeMigration, /gate_assignment_usage_deltas_history_archive_idx[\s\S]*created_at, sample_id/);
});
