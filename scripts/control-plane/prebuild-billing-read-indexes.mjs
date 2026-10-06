// Nonblocking preparation for migration 0054. No history is deleted.
import { createDatabase } from "../../packages/db/dist/index.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const db = createDatabase({ connectionString: process.env.DATABASE_URL, applicationName: "billing-read-index-rollout", maxConnections: 1 });
const indexes = [
  ["users_active_account_created_idx", "ON users (account_id, created_at) WHERE disabled_at IS NULL"],
  ["gate_usage_egress_window_idx", "ON gate_assignment_usage_deltas (window_end, assignment_id) WHERE role = 'Egress'"]
];
try {
  await db.query("SET lock_timeout = '5s'");
  await db.query("SET statement_timeout = '5min'");
  for (const [name, definition] of indexes) {
    const existing = await db.query("SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)", [name]);
    if (existing.rows[0]?.indisvalid === false) throw new Error(`Invalid existing index ${name}; inspect it before continuing`);
    await db.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ${definition}`);
    const checked = await db.query("SELECT indisvalid, pg_size_pretty(pg_relation_size(indexrelid)) AS size FROM pg_index WHERE indexrelid = to_regclass($1)", [name]);
    if (checked.rows[0]?.indisvalid !== true) throw new Error(`Index is not valid: ${name}`);
    console.log(JSON.stringify({ index: name, ...checked.rows[0] }));
  }
} finally { await db.close(); }
