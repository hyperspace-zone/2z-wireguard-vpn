import type { Database } from "@hyperspace-zone/db";
import { measurementStore } from "@hyperspace-zone/control-plane";

/** Probe history is expendable, unlike the billing ledger. Bounded batches
 * remove parent+attempts together, including orphaned unfinished attempts.
 * No NFS archive availability dependency and no maintenance in core. */
export async function cleanupProbesHistory(db: Database): Promise<void> {
  const mongoBacked = Boolean(measurementStore(db));
  await db.transaction(async client => {
    await client.query("SET LOCAL lock_timeout='500ms'");
    await client.query(`DELETE FROM trading_probe_jobs WHERE id IN (
      SELECT id FROM trading_probe_jobs WHERE phase IN ('succeeded','failed','dead')
      AND updated_at < now()-interval '2 days' ORDER BY updated_at,id LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
    await client.query(`DELETE FROM jobs WHERE id IN (
      SELECT id FROM jobs WHERE phase IN ('succeeded','dead','acknowledged_dead')
      AND updated_at < now()-interval '2 days' ORDER BY updated_at,id LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
    // Mongo owns measurement TTL; PostgreSQL retains only the job journal.
    if (mongoBacked) return;
    await client.query(`DELETE FROM gate_benchmark_results WHERE id IN (
      SELECT id FROM gate_benchmark_results WHERE created_at < now()-interval '2 days'
      ORDER BY created_at,id LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
    await client.query(`DELETE FROM trading_latency_rollups WHERE id IN (
      SELECT id FROM trading_latency_rollups WHERE bucket_start < now()-interval '14 days'
      ORDER BY bucket_start,id LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
  });
}
