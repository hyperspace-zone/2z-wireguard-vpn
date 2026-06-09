import type { Queryable } from "../../db/queryable.js";
import { insertEntitlement, type CreateEntitlementInput } from "./repository.js";

export function addEntitlementSeconds(currentSeconds: number, addedSeconds: number): number {
  return Math.max(0, currentSeconds) + Math.max(0, addedSeconds);
}

export async function createEntitlement(db: Queryable, input: CreateEntitlementInput): Promise<string> {
  return insertEntitlement(db, {
    ...input,
    purchasedDurationSeconds: addEntitlementSeconds(0, input.purchasedDurationSeconds)
  });
}
