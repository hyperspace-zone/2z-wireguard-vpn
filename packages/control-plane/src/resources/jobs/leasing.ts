import type { TransactionalQueryable } from "../../db/queryable.js";
import {
  findClaimableGateJobForUpdate,
  insertJobAttemptLease,
  nextJobAttemptNumber,
  updateJobLease,
  type ClaimedGateJob,
  type GateJobLeaseIdentity
} from "./repository.js";
import { findAssignmentPhaseForUpdate, updateAssignmentPhase } from "../gate-assignments/repository.js";
import { leasedAssignmentTransition, type GateAssignmentPhase } from "../gate-assignments/transitions.js";
import { claimJobTransition } from "./transitions.js";

export type { ClaimedGateJob, GateJobLeaseIdentity } from "./repository.js";

export async function claimGateJob(
  db: TransactionalQueryable,
  gate: GateJobLeaseIdentity
): Promise<ClaimedGateJob | null> {
  return db.transaction(async (client) => {
    const job = await findClaimableGateJobForUpdate(client, gate.id);
    if (!job) {
      return null;
    }

    const attemptNumber = await nextJobAttemptNumber(client, job.id);
    const jobTransition = claimJobTransition();
    await updateJobLease(client, {
      jobId: job.id,
      phase: jobTransition.phase,
      leaseOwner: gate.name,
      leaseSeconds: jobTransition.leaseSeconds
    });
    await insertJobAttemptLease(client, {
      jobId: job.id,
      attemptNumber,
      leaseOwner: gate.name,
      leaseSeconds: jobTransition.leaseSeconds
    });

    if (job.assignmentId) {
      const assignmentPhase = await findAssignmentPhaseForUpdate(client, job.assignmentId);
      if (!assignmentPhase) {
        throw new Error(`job ${job.id} references missing assignment ${job.assignmentId}`);
      }
      await updateAssignmentPhase(client, {
        assignmentId: job.assignmentId,
        phase: leasedAssignmentTransition(job.type, assignmentPhase as GateAssignmentPhase)
      });
    }

    return {
      ...job,
      attemptNumber
    };
  });
}
