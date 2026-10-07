import type { Queryable } from "../db/queryable.js";
import type { MeasurementStore } from "./mongo.js";

export async function deliverMeasurements(db: Queryable, store: MeasurementStore, limit = 100): Promise<number> {
  const batch = await db.query<{ id: string; kind: "benchmark" | "trading"; payload: unknown }>(`
    SELECT id,kind,payload FROM measurement_delivery_outbox
    WHERE next_attempt_at <= now() ORDER BY created_at,id LIMIT $1`, [limit]);
  let delivered = 0;
  for (const row of batch.rows) {
    try {
      await store.deliver(row.id, row.kind, row.payload);
    } catch {
      await db.query(`UPDATE measurement_delivery_outbox SET attempts=attempts+1,
        next_attempt_at=now()+make_interval(secs=>LEAST(60,5*(attempts+1))) WHERE id=$1`, [row.id]);
      // A failed destination must not turn one batch into 100 network timeouts.
      throw new Error("Measurement delivery unavailable; reports retained in probes journal");
    }
    await db.query("DELETE FROM measurement_delivery_outbox WHERE id=$1", [row.id]);
    delivered += 1;
  }
  return delivered;
}
