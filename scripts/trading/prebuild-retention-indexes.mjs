// Run before migration 0041 on an existing fleet. Never blocks probe writes
// with a non-concurrent index build and never drops an existing index.
import { createDatabase } from "../../packages/db/dist/index.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const db = createDatabase({ connectionString: process.env.DATABASE_URL, applicationName: "trading-retention-index-rollout", maxConnections: 1 });
try {
  for (const [name, statement] of [
    ["trading_probe_jobs_retention_idx", "CREATE INDEX CONCURRENTLY IF NOT EXISTS trading_probe_jobs_retention_idx ON trading_probe_jobs (updated_at, id) WHERE phase IN ('succeeded', 'failed', 'dead')"],
    ["trading_latency_rollups_retention_idx", "CREATE INDEX CONCURRENTLY IF NOT EXISTS trading_latency_rollups_retention_idx ON trading_latency_rollups (bucket_start, id)"]
  ]) {
    const existing = await db.query("SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)", [name]);
    if (existing.rows[0]?.indisvalid === false) throw new Error(`Invalid existing index ${name}; inspect it before continuing`);
    await db.query(statement);
    const checked = await db.query("SELECT indisvalid, pg_size_pretty(pg_relation_size(indexrelid)) AS size FROM pg_index WHERE indexrelid = to_regclass($1)", [name]);
    if (checked.rows[0]?.indisvalid !== true) throw new Error(`Index is not valid: ${name}`);
    console.log(JSON.stringify({ index: name, ...checked.rows[0] }));
  }
} finally { await db.close(); }
