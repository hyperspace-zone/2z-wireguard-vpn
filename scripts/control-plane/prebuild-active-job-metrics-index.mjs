// Additive, nonblocking preparation for migration 0044. No history is deleted.
import { createDatabase } from "../../packages/db/dist/index.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const db = createDatabase({ connectionString: process.env.DATABASE_URL, applicationName: "actionable-job-metrics-index-rollout", maxConnections: 1 });
try {
  const name = "jobs_actionable_metrics_idx";
  const existing = await db.query("SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)", [name]);
  if (existing.rows[0]?.indisvalid === false) throw new Error(`Invalid existing index ${name}; inspect it before continuing`);
  await db.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_actionable_metrics_idx ON jobs (type, phase) WHERE phase <> 'succeeded'");
  const checked = await db.query("SELECT indisvalid, pg_size_pretty(pg_relation_size(indexrelid)) AS size FROM pg_index WHERE indexrelid = to_regclass($1)", [name]);
  if (checked.rows[0]?.indisvalid !== true) throw new Error(`Index is not valid: ${name}`);
  console.log(JSON.stringify({ index: name, ...checked.rows[0] }));
} finally { await db.close(); }
