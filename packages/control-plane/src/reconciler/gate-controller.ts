import type { Queryable } from "../db/queryable.js";
import { markStaleGateConditions } from "../resources/gates/repository.js";

export async function markStaleGates(db: Queryable, staleSeconds: number): Promise<void> {
  await markStaleGateConditions(db, staleSeconds);
}
