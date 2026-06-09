import type { Queryable } from "../db/queryable.js";
import { markStaleGateConditions } from "../resources/gates/repository.js";
import { resolveGateStaleConditions } from "../resources/gates/transitions.js";

export async function markStaleGates(db: Queryable, staleSeconds: number): Promise<void> {
  await markStaleGateConditions(db, staleSeconds, resolveGateStaleConditions());
}
