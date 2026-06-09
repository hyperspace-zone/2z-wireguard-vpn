import type { Queryable } from "../../db/queryable.js";
import {
  ensureGateAssignmentStatusPhase,
  markAssignmentRevoking,
  markMissingHandleAssignmentRowsDrifted,
  markPendingAssignmentsPhaseForSession,
  markPreparedAssignmentsQueued,
  updateAssignmentDesiredState,
  upsertGateAssignment,
  type CreateGateAssignmentInput
} from "./repository.js";
import {
  deadForProvisioningFailureTransition,
  desiredAppliedTransition,
  desiredRevokedTransition,
  driftedAssignmentTransition,
  provisioningFailureDeadCandidatePhases,
  queuedAfterAssignmentUpsertTransition,
  queuedForCommitTransition
} from "./transitions.js";

export async function createAssignment(
  db: Queryable,
  input: Omit<CreateGateAssignmentInput, "desiredState">
): Promise<string> {
  const desired = desiredAppliedTransition();
  const assignmentId = await upsertGateAssignment(db, {
    ...input,
    desiredState: desired.desiredState
  });
  await ensureGateAssignmentStatusPhase(db, {
    assignmentId,
    phase: queuedAfterAssignmentUpsertTransition("planned")
  });
  return assignmentId;
}

export async function queuePreparedAssignmentsForCommit(
  db: Queryable,
  ingressAssignmentId: string,
  egressAssignmentId: string
): Promise<void> {
  await markPreparedAssignmentsQueued(db, ingressAssignmentId, egressAssignmentId, queuedForCommitTransition());
}

export async function markPendingAssignmentsDeadForSession(
  db: Queryable,
  sessionId: string,
  error: Record<string, unknown>
): Promise<void> {
  await markPendingAssignmentsPhaseForSession(db, {
    sessionId,
    nextPhase: deadForProvisioningFailureTransition("queued"),
    error,
    candidatePhases: provisioningFailureDeadCandidatePhases
  });
}

export async function requestAssignmentRevocation(db: Queryable, assignmentId: string): Promise<void> {
  const transition = desiredRevokedTransition();
  await updateAssignmentDesiredState(db, {
    assignmentId,
    desiredState: transition.desiredState,
    incrementGeneration: transition.incrementGeneration
  });
  await markAssignmentRevoking(db, assignmentId, transition.statusPhase);
}

export async function markMissingHandleAssignmentsDrifted(
  db: Queryable,
  gateId: string,
  missingHandles: string[]
): Promise<void> {
  await markMissingHandleAssignmentRowsDrifted(db, {
    gateId,
    missingHandles,
    nextPhase: driftedAssignmentTransition(),
    error: {
      code: "actual_state_missing_handle",
      message: "Desired assignment handle is absent from gate actual state"
    }
  });
}
