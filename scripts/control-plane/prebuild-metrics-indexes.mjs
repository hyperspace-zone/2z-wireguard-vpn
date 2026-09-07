// Run before migration 0042 on an existing fleet. No jobs are changed/deleted.
import { createDatabase } from "../../packages/db/dist/index.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const db = createDatabase({ connectionString: process.env.DATABASE_URL, applicationName: "job-metrics-index-rollout", maxConnections: 1 });
try {
  const name = "jobs_metrics_type_phase_idx";
  const existing = await db.query("SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)", [name]);
  if (existing.rows[0]?.indisvalid === false) throw new Error(`Invalid existing index ${name}; inspect it before continuing`);
  await db.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_metrics_type_phase_idx ON jobs (type, phase)");
  const checked = await db.query("SELECT indisvalid, pg_size_pretty(pg_relation_size(indexrelid)) AS size FROM pg_index WHERE indexrelid = to_regclass($1)", [name]);
  if (checked.rows[0]?.indisvalid !== true) throw new Error(`Index is not valid: ${name}`);
  console.log(JSON.stringify({ index: name, ...checked.rows[0] }));
  // Existing append/update-heavy histories may need a current visibility map.
  // Ordinary VACUUM keeps writes online; never use FULL or truncate the table.
  if (process.argv.includes("--vacuum")) {
    await db.query("VACUUM (ANALYZE, TRUNCATE FALSE) jobs");
    console.log(JSON.stringify({ vacuum: "jobs", full: false, truncate: false }));
  }
} finally { await db.close(); }
