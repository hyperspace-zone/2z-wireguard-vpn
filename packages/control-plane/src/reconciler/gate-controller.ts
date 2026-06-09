import type { Queryable } from "../db/queryable.js";
import { markStaleGateConditions } from "../resources/gates/conditions.js";

export async function markStaleGates(db: Queryable, staleSeconds: number): Promise<void> {
  await markStaleGateConditions(db, staleSeconds);
}
