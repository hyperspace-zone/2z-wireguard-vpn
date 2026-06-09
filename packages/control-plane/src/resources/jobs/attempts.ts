import type { TransactionalQueryable } from "../../db/queryable.js";
import {
  findJobForReportForUpdate,
  markAssignmentAppliedFromReport,
  markAssignmentFailedFromReport,
  markAssignmentPreparedFromReport,
  markAssignmentRevokedFromReport,
  recordJobReportOutcome
} from "./repository.js";
import { resolveReportedJobTransition, type JobReportStatus } from "./transitions.js";

export interface GateJobReport {
  status: JobReportStatus;
  actualStateHash: string;
  errorCode: string;
  resultSummary: Record<string, unknown>;
}

export async function recordGateJobReport(
  db: TransactionalQueryable,
  gateId: string,
  jobId: string,
  report: GateJobReport
): Promise<boolean> {
  return db.transaction(async (client) => {
    const row = await findJobForReportForUpdate(client, gateId, jobId);
    if (!row) {
      return false;
    }

    const transition = resolveReportedJobTransition(report.status, row.retryCount, row.maxRetries);
    await recordJobReportOutcome(client, {
      jobId: row.id,
      nextPhase: transition.nextPhase,
      retryableDelay: transition.retryableDelay,
      actualStateHash: report.actualStateHash,
      errorCode: report.errorCode,
      resultSummary: report.resultSummary
    });

    if (row.assignmentId) {
      await recordAssignmentProgress(client, {
        assignmentId: row.assignmentId,
        jobType: row.type,
        report,
        terminalFailure: transition.terminalFailure
      });
    }

    return true;
  });
}

async function recordAssignmentProgress(
  db: Parameters<typeof markAssignmentPreparedFromReport>[0],
  input: {
    assignmentId: string;
    jobType: string;
    report: GateJobReport;
    terminalFailure: boolean;
  }
): Promise<void> {
  if (input.report.status === "succeeded" && input.jobType === "apply_assignment") {
    const operation = readString(input.report.resultSummary, "operation") || "commit";
    if (operation === "prepare") {
      await markAssignmentPreparedFromReport(db, {
        assignmentId: input.assignmentId,
        actualStateHash: input.report.actualStateHash,
        errorCode: input.report.errorCode,
        resultSummary: input.report.resultSummary,
        material: asRecord(input.report.resultSummary.material ?? {})
      });
      return;
    }

    await markAssignmentAppliedFromReport(db, {
      assignmentId: input.assignmentId,
      actualStateHash: input.report.actualStateHash,
      errorCode: input.report.errorCode,
      resultSummary: input.report.resultSummary
    });
    return;
  }

  if (input.report.status === "succeeded" && input.jobType === "revoke_assignment") {
    await markAssignmentRevokedFromReport(db, {
      assignmentId: input.assignmentId,
      actualStateHash: input.report.actualStateHash,
      errorCode: input.report.errorCode,
      resultSummary: input.report.resultSummary
    });
    return;
  }

  await markAssignmentFailedFromReport(db, {
    assignmentId: input.assignmentId,
    terminalFailure: input.terminalFailure,
    errorCode: input.report.errorCode,
    resultSummary: input.report.resultSummary
  });
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
