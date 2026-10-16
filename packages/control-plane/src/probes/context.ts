import type { Database } from "@hyperspace-zone/db";
import { attachMeasurementStore } from "../measurements/context.js";
import type { MongoProbeStore } from "./mongo.js";

const stores = new WeakMap<object, MongoProbeStore>();
export const probeStore = (context: object): MongoProbeStore | undefined => stores.get(context);

/** Compatibility boundary for existing service signatures. This is NOT a SQL
 * adapter: every probes operation must dispatch explicitly to its repository.
 * An accidental SQL path fails closed, never falling back to core PostgreSQL.
 * No pool, connection or SQL transaction is created in Mongo-only mode. */
export function createMongoProbesContext(store: MongoProbeStore): Database {
  const forbidden = () => { throw new Error("SQL is forbidden in the Mongo-only probes context"); };
  const context: Database = { get pool() { return forbidden(); }, query: async () => forbidden(),
    transaction: async () => forbidden(), close: async () => {} };
  stores.set(context, store);
  attachMeasurementStore(context, store.measurements);
  return context;
}
