export type GateAssignmentDesiredState = "Applied" | "Revoked";

export type GateAssignmentPhase =
  | "planned"
  | "queued"
  | "leased"
  | "applying"
  | "prepared"
  | "applied"
  | "drifted"
  | "revoking"
  | "revoked"
  | "retryable_failed"
  | "dead";

export const provisioningFailureDeadCandidatePhases: readonly GateAssignmentPhase[] = [
  "planned",
  "queued",
  "leased",
  "applying",
  "prepared",
  "retryable_failed"
];

export function isTerminalAssignmentPhase(phase: string): boolean {
  return phase === "applied" || phase === "revoked" || phase === "dead";
}

export function queuedAfterAssignmentUpsertTransition(currentPhase?: GateAssignmentPhase): GateAssignmentPhase {
  return currentPhase === "applied" ? "applied" : "queued";
}

export function desiredAppliedTransition(): {
  desiredState: GateAssignmentDesiredState;
  statusPhase: GateAssignmentPhase;
} {
  return {
    desiredState: "Applied",
    statusPhase: "queued"
  };
}

export function queuedForCommitTransition(): GateAssignmentPhase {
  return "queued";
}

export function leasedAssignmentTransition(jobType: string, currentPhase: GateAssignmentPhase): GateAssignmentPhase {
  if (currentPhase === "applied" || currentPhase === "revoked") {
    return currentPhase;
  }
  return jobType === "revoke_assignment" ? "revoking" : "applying";
}

export function preparedFromReportTransition(): GateAssignmentPhase {
  return "prepared";
}

export function appliedFromReportTransition(): GateAssignmentPhase {
  return "applied";
}

export function revokedFromReportTransition(): GateAssignmentPhase {
  return "revoked";
}

export function failedFromReportTransition(terminalFailure: boolean): GateAssignmentPhase {
  return terminalFailure ? "dead" : "retryable_failed";
}

export function desiredRevokedTransition(): {
  desiredState: GateAssignmentDesiredState;
  incrementGeneration: boolean;
  statusPhase: GateAssignmentPhase;
} {
  return {
    desiredState: "Revoked",
    incrementGeneration: true,
    statusPhase: "revoking"
  };
}

export function deadForProvisioningFailureTransition(currentPhase: GateAssignmentPhase): GateAssignmentPhase {
  if (currentPhase === "applied" || currentPhase === "revoked" || currentPhase === "dead") {
    return currentPhase;
  }
  return "dead";
}
