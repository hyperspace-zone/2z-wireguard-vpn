import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { runMigrations } from "./index.js";

/** Empty, reproducible measurement schema. Catalog and credentials come from
 * core, not from restoring historical measurements. Never run core migrations
 * against this instance: they contain transactional/user tables. */
export async function runProbesMigrations(pool: Pool): Promise<void> {
  await runMigrations(pool, fileURLToPath(new URL("../probes-migrations", import.meta.url)));
  const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
  const exists = await pool.query("SELECT 1 FROM schema_migrations WHERE version='probes_trading_schema_v1'");
  if (!exists.rowCount) {
    const migration = await readFile(new URL("../migrations/0037_trading_latency_probes.sql", import.meta.url), "utf8");
    const schema = migration.split("INSERT INTO trading_probe_targets (")[0];
    if (!schema?.includes("CREATE TABLE trading_latency_rollups")) throw new Error("Trading schema boundary changed");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(schema);
      await client.query("INSERT INTO schema_migrations(version) VALUES('probes_trading_schema_v1')");
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  await runMigrations(pool, migrationsDir, [
    "0014_gate_benchmark_results.sql", "0015_gate_benchmark_clock_error.sql",
    "0030_benchmark_scheduler_indexes.sql", "0041_trading_history_retention_indexes.sql",
    "0050_trading_incomplete_attempt_index.sql"
  ]);
  await pool.query("CREATE INDEX IF NOT EXISTS gate_benchmark_results_job_id_idx ON gate_benchmark_results(job_id)");
}
