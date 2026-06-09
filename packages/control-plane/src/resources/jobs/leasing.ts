import type { TransactionalQueryable } from "../../db/queryable.js";
import {
  claimGateJobLease,
  type ClaimedGateJob,
  type GateJobLeaseIdentity
} from "./repository.js";

export type { ClaimedGateJob, GateJobLeaseIdentity } from "./repository.js";

export async function claimGateJob(
  db: TransactionalQueryable,
  gate: GateJobLeaseIdentity
): Promise<ClaimedGateJob | null> {
  return claimGateJobLease(db, gate);
}
