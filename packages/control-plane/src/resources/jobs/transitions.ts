export type JobReportStatus = "succeeded" | "retryable_failed" | "failed";
export type TerminalJobPhase = "succeeded" | "dead" | "retryable_failed";

export interface ReportedJobTransition {
  nextPhase: TerminalJobPhase;
  terminalFailure: boolean;
  retryableDelay: boolean;
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
    retryableDelay: status === "retryable_failed" && !terminalFailure
  };
}
