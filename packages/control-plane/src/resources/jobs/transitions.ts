export type JobReportStatus = "succeeded" | "retryable_failed" | "failed";
export type JobPhase = "queued" | "leased" | "running" | "succeeded" | "retryable_failed" | "dead";
export type TerminalJobPhase = "succeeded" | "dead" | "retryable_failed";

export const sessionFailureDeadCandidateJobPhases: readonly JobPhase[] = [
  "queued",
  "leased",
  "running",
  "retryable_failed"
];

export const expiredLeaseCandidateJobPhases: readonly JobPhase[] = [
  "leased",
  "running"
];

export interface ReportedJobTransition {
  nextPhase: TerminalJobPhase;
  terminalFailure: boolean;
  retryDelaySeconds: number | null;
}

export function isJobReportStatus(value: string): value is JobReportStatus {
  return value === "succeeded" || value === "retryable_failed" || value === "failed";
}

export function resolveReportedJobTransition(
  status: JobReportStatus,
  retryCount: number,
  maxRetries: number
): ReportedJobTransition {
  const terminalFailure = status === "failed" || (status === "retryable_failed" && retryCount + 1 >= maxRetries);
  return {
    nextPhase: status === "succeeded" ? "succeeded" : terminalFailure ? "dead" : "retryable_failed",
    terminalFailure,
    retryDelaySeconds: status === "retryable_failed" && !terminalFailure ? 10 : null
  };
}

export function claimJobTransition(): {
  phase: JobPhase;
  leaseSeconds: number;
} {
  return {
    phase: "leased",
    leaseSeconds: 60
  };
}

export function queuedJobTransition(): JobPhase {
  return "queued";
}

export function expiredLeaseTransition(currentPhase: JobPhase): JobPhase {
  if (currentPhase === "leased" || currentPhase === "running") {
    return "queued";
  }
  return currentPhase;
}

export function deadForSessionFailureTransition(currentPhase: JobPhase): JobPhase {
  if (currentPhase === "queued" || currentPhase === "leased" || currentPhase === "running" || currentPhase === "retryable_failed") {
    return "dead";
  }
  return currentPhase;
}
