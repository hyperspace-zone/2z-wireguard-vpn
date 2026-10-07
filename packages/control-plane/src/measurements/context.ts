import type { Queryable, TransactionalQueryable } from "../db/queryable.js";
import type { MeasurementStore } from "./mongo.js";

const stores = new WeakMap<object, MeasurementStore>();
export const measurementStore = (db: Queryable): MeasurementStore | undefined => stores.get(db);

/** Associate an optional measurement repository without changing core DB APIs.
 * Propagate only to this transaction's client; pooled clients must not retain it. */
export function attachMeasurementStore<T extends TransactionalQueryable>(db: T, store: MeasurementStore): T {
  if (stores.has(db)) throw new Error("Measurement store already attached");
  stores.set(db, store);
  const transaction = db.transaction.bind(db);
  db.transaction = fn => transaction(async client => {
    stores.set(client, store);
    try { return await fn(client); } finally { stores.delete(client); }
  });
  return db;
}

export async function enqueueMeasurement(db: Queryable, id: string, kind: "benchmark" | "trading", payload: unknown): Promise<void> {
  await db.query(`INSERT INTO measurement_delivery_outbox(id,kind,payload)
    VALUES($1,$2,$3::jsonb) ON CONFLICT(id) DO NOTHING`, [id, kind, JSON.stringify(payload)]);
}

export async function markMeasurementScheduled(db: Queryable, kind: string, source: string, target: string, profile: string, revision = 0): Promise<void> {
  await db.query(`INSERT INTO probe_measurement_schedule(kind,source_id,target_id,network_profile,target_revision)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(kind,source_id,target_id,network_profile)
    DO UPDATE SET completed_at=now(),target_revision=EXCLUDED.target_revision`, [kind,source,target,profile,revision]);
}
