import type { Queryable } from "../../db/queryable.js";
import type { RevocableAssignmentRow } from "../gate-assignments/repository.js";
import {
  insertApplyAssignmentJob,
  insertReconcileJob,
  insertRevokeAssignmentJob,
  markApplyJobsPhaseForSession,
  updateExpiredJobLeasePhases,
  type EnqueueApplyJobInput,
  type EnqueueReconcileJobInput
} from "./repository.js";
import {
  deadForSessionFailureTransition,
  expiredLeaseCandidateJobPhases,
  expiredLeaseTransition,
  sessionFailureDeadCandidateJobPhases,
  queuedJobTransition
} from "./transitions.js";

export async function enqueueApplyJob(
  db: Queryable,
  input: EnqueueApplyJobInput
): Promise<void> {
  await insertApplyAssignmentJob(db, {
    ...input,
    initialPhase: queuedJobTransition()
  });
}

export async function enqueueRevokeAssignmentJob(
  db: Queryable,
  assignment: RevocableAssignmentRow
): Promise<void> {
  await insertRevokeAssignmentJob(db, {
    ...assignment,
    initialPhase: queuedJobTransition()
  });
}

export async function enqueueReconcileJob(
  db: Queryable,
  input: EnqueueReconcileJobInput
): Promise<string> {
  return insertReconcileJob(db, {
    ...input,
    initialPhase: queuedJobTransition()
  });
}

export async function markApplyJobsDeadForSession(db: Queryable, sessionId: string): Promise<void> {
  await markApplyJobsPhaseForSession(db, {
    sessionId,
    nextPhase: deadForSessionFailureTransition("queued"),
    candidatePhases: sessionFailureDeadCandidateJobPhases
  });
}

export async function requeueExpiredJobLeases(db: Queryable): Promise<void> {
  await updateExpiredJobLeasePhases(db, {
    nextPhase: expiredLeaseTransition("leased"),
    candidatePhases: expiredLeaseCandidateJobPhases
  });
}
