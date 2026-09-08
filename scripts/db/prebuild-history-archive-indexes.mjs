#!/usr/bin/env node

import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const statements = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_history_archive_idx
     ON jobs (updated_at, id)
     WHERE phase IN ('succeeded', 'dead')`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS gate_benchmark_results_created_history_archive_idx
     ON gate_benchmark_results (created_at, id)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS gate_benchmark_results_job_id_idx
     ON gate_benchmark_results (job_id)
     WHERE job_id IS NOT NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS gate_assignment_counter_samples_history_archive_idx
     ON gate_assignment_counter_samples (received_at, id)`
];

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  for (const statement of statements) {
    process.stderr.write(`${statement.split("\n")[0]}\n`);
    await client.query(statement);
  }
  const validation = await client.query(`
    SELECT indexrelid::regclass::text AS name, indisvalid, indisready
    FROM pg_index
    WHERE indexrelid IN (
      'jobs_history_archive_idx'::regclass,
      'gate_benchmark_results_created_history_archive_idx'::regclass,
      'gate_benchmark_results_job_id_idx'::regclass,
      'gate_assignment_counter_samples_history_archive_idx'::regclass
    )
    ORDER BY 1
  `);
  if (validation.rows.length !== statements.length || validation.rows.some((row) => !row.indisvalid || !row.indisready)) {
    throw new Error(`history archive indexes are not ready: ${JSON.stringify(validation.rows)}`);
  }
  process.stdout.write(`${JSON.stringify(validation.rows)}\n`);
} finally {
  await client.end();
}
