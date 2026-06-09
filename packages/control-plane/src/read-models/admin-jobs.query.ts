import type { JobSummary } from "@hyperspace-zone/contracts";
import type { Queryable } from "../db/queryable.js";

interface AdminJobRow {
  id: string;
  type: JobSummary["type"];
  phase: JobSummary["phase"];
  gateId: string | null;
  sessionId: string | null;
  assignmentId: string | null;
  payload: Record<string, unknown>;
  retryCount: number;
  maxRetries: number;
  runAfter: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listAdminJobs(db: Queryable): Promise<JobSummary[]> {
  const result = await db.query<AdminJobRow>(
    `
      SELECT
        id,
        type::text,
        phase::text,
        gate_id AS "gateId",
        session_id AS "sessionId",
        assignment_id AS "assignmentId",
        payload,
        retry_count AS "retryCount",
        max_retries AS "maxRetries",
        run_after AS "runAfter",
        lease_owner AS "leaseOwner",
        lease_expires_at AS "leaseExpiresAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM jobs
      ORDER BY created_at DESC
      LIMIT 500
    `
  );
  return result.rows.map(mapAdminJobRow);
}

function mapAdminJobRow(row: AdminJobRow): JobSummary {
  return {
    id: row.id,
    type: row.type,
    phase: row.phase,
    ...(row.gateId ? { gateId: row.gateId } : {}),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(row.assignmentId ? { assignmentId: row.assignmentId } : {}),
    payload: row.payload,
    retryCount: row.retryCount,
    maxRetries: row.maxRetries,
    runAfter: row.runAfter,
    ...(row.leaseOwner ? { leaseOwner: row.leaseOwner } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}
