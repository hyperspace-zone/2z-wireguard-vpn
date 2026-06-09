import type { Queryable } from "../../db/queryable.js";
import { gateHeartbeatLeaseTtlSeconds } from "./policy.js";
import { upsertGateLease } from "./repository.js";
export { gateHeartbeatLeaseTtlSeconds } from "./policy.js";

export async function recordGateLease(
  db: Queryable,
  input: {
    gateId: string;
    leaseOwner: string;
    heartbeatIntervalSeconds?: number;
  }
): Promise<void> {
  await upsertGateLease(db, {
    gateId: input.gateId,
    leaseOwner: input.leaseOwner,
    ttlSeconds: gateHeartbeatLeaseTtlSeconds(input.heartbeatIntervalSeconds)
  });
}

export function isGateLeaseFresh(leaseExpiresAt: Date, now = new Date()): boolean {
  return leaseExpiresAt.getTime() > now.getTime();
}
