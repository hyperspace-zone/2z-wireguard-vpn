import type { Queryable } from "../../db/queryable.js";
import { mustRow } from "../../support/db.js";

export interface GateJobLeaseIdentity {
  id: string;
  name: string;
}

export interface ClaimedGateJob {
  id: string;
  type: string;
  payload: unknown;
  sessionId: string | null;
  assignmentId: string | null;
  attemptNumber: number;
}

export interface LockedJobForReport {
  id: string;
  type: string;
  assignmentId: string | null;
  retryCount: number;
  maxRetries: number;
}

export interface GateJobReportPersistenceInput {
  actualStateHash: string;
  errorCode: string;
  resultSummary: Record<string, unknown>;
}

export interface EnqueueApplyJobInput {
  assignmentId: string;
  gateId: string;
  sessionId: string;
  operation: "prepare" | "commit";
  role: "Ingress" | "Egress";
  plan?: Record<string, unknown>;
  networkPlan?: Record<string, unknown>;
}

export interface EnqueueRevokeAssignmentJobInput {
  assignmentId: string;
  gateId: string;
  sessionId: string;
  role: "Ingress" | "Egress";
}

export interface EnqueueReconcileJobInput {
  gateId?: string;
  sessionId?: string;
  requestedBy: string;
  reason?: string;
}

export async function findClaimableGateJobForUpdate(
  db: Queryable,
  gateId: string
): Promise<Omit<ClaimedGateJob, "attemptNumber"> | null> {
  const job = await db.query<Omit<ClaimedGateJob, "attemptNumber">>(
    `
      SELECT
        id,
        type::text,
        payload,
        session_id AS "sessionId",
        assignment_id AS "assignmentId"
      FROM jobs
      WHERE gate_id = $1
        AND phase IN ('queued', 'retryable_failed')
        AND run_after <= now()
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `,
    [gateId]
  );
  return job.rows[0] ?? null;
}

export async function nextJobAttemptNumber(db: Queryable, jobId: string): Promise<number> {
  const attempt = await db.query<{ attemptNumber: number }>(
    `
      SELECT COALESCE(MAX(attempt_number), 0) + 1 AS "attemptNumber"
      FROM job_attempts
      WHERE job_id = $1
    `,
    [jobId]
  );
  return mustRow(attempt).attemptNumber;
}

export async function updateJobLease(
  db: Queryable,
  input: {
    jobId: string;
    phase: string;
    leaseOwner: string;
    leaseSeconds: number;
  }
): Promise<void> {
  await db.query(
    `
      UPDATE jobs
      SET phase = $2::job_phase,
          lease_owner = $3,
          lease_expires_at = now() + ($4::int * interval '1 second'),
          updated_at = now()
      WHERE id = $1
    `,
    [input.jobId, input.phase, input.leaseOwner, input.leaseSeconds]
  );
}

export async function insertJobAttemptLease(
  db: Queryable,
  input: {
    jobId: string;
    attemptNumber: number;
    leaseOwner: string;
    leaseSeconds: number;
  }
): Promise<void> {
  await db.query(
    `
      INSERT INTO job_attempts (job_id, attempt_number, lease_owner, lease_expires_at)
      VALUES ($1, $2, $3, now() + ($4::int * interval '1 second'))
    `,
    [input.jobId, input.attemptNumber, input.leaseOwner, input.leaseSeconds]
  );
}

export async function findJobForReportForUpdate(
  db: Queryable,
  gateId: string,
  jobId: string
): Promise<LockedJobForReport | null> {
  const job = await db.query<LockedJobForReport>(
    `
      SELECT
        id,
        type::text,
        assignment_id AS "assignmentId",
        retry_count AS "retryCount",
        max_retries AS "maxRetries"
      FROM jobs
      WHERE id = $1 AND gate_id = $2
      FOR UPDATE
    `,
    [jobId, gateId]
  );
  return job.rows[0] ?? null;
}

export async function recordJobReportOutcome(
  db: Queryable,
  input: GateJobReportPersistenceInput & {
    jobId: string;
    nextPhase: string;
    retryDelaySeconds: number | null;
  }
): Promise<void> {
  await db.query(
    `
      UPDATE jobs
      SET phase = $2::job_phase,
          retry_count = CASE WHEN $2::job_phase = 'retryable_failed' THEN retry_count + 1 ELSE retry_count END,
          lease_expires_at = NULL,
          run_after = CASE
            WHEN $3::int IS NULL THEN now()
            ELSE now() + ($3::int * interval '1 second')
          END,
          updated_at = now()
      WHERE id = $1
    `,
    [input.jobId, input.nextPhase, input.retryDelaySeconds]
  );
  await db.query(
    `
      UPDATE job_attempts
      SET completed_at = now(),
          result_summary = $2::jsonb,
          error_code = $3,
          actual_state_hash = $4
      WHERE job_id = $1
        AND completed_at IS NULL
    `,
    [
      input.jobId,
      JSON.stringify(input.resultSummary),
      input.errorCode || null,
      input.actualStateHash || null
    ]
  );
}

export async function insertApplyAssignmentJob(
  db: Queryable,
  input: EnqueueApplyJobInput & {
    initialPhase: string;
  }
): Promise<void> {
  await db.query(
    `
      INSERT INTO jobs (type, phase, gate_id, session_id, assignment_id, payload)
      SELECT 'apply_assignment', $5::job_phase, $1, $2, $3, $4::jsonb
      WHERE NOT EXISTS (
        SELECT 1
        FROM jobs
        WHERE assignment_id = $3
          AND type = 'apply_assignment'
          AND payload->>'operation' = $6
          AND phase IN ('queued', 'leased', 'running', 'retryable_failed')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jobs
        JOIN gate_assignment_status
          ON gate_assignment_status.assignment_id = jobs.assignment_id
        WHERE jobs.assignment_id = $3
          AND jobs.type = 'apply_assignment'
          AND jobs.payload->>'operation' = $6
          AND jobs.phase = 'succeeded'
          AND gate_assignment_status.phase IN ('queued', 'leased', 'applying', 'prepared')
      )
    `,
    [
      input.gateId,
      input.sessionId,
      input.assignmentId,
      JSON.stringify({
        assignmentId: input.assignmentId,
        operation: input.operation,
        role: input.role,
        ...(input.plan ? { plan: input.plan } : {}),
        ...(input.networkPlan ? { networkPlan: input.networkPlan } : {})
      }),
      input.initialPhase,
      input.operation
    ]
  );
}

export async function insertRevokeAssignmentJob(
  db: Queryable,
  input: EnqueueRevokeAssignmentJobInput & {
    initialPhase: string;
  }
): Promise<void> {
  await db.query(
    `
      INSERT INTO jobs (type, phase, gate_id, session_id, assignment_id, payload)
      SELECT 'revoke_assignment', $5::job_phase, $1, $2, $3, $4::jsonb
      WHERE NOT EXISTS (
        SELECT 1
        FROM jobs
        WHERE assignment_id = $3
          AND type = 'revoke_assignment'
          AND phase IN ('queued', 'leased', 'running', 'retryable_failed')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jobs
        WHERE assignment_id = $3
          AND type = 'revoke_assignment'
          AND phase = 'succeeded'
      )
    `,
    [
      input.gateId,
      input.sessionId,
      input.assignmentId,
      JSON.stringify({ assignmentId: input.assignmentId, role: input.role }),
      input.initialPhase
    ]
  );
}

export async function markApplyJobsPhaseForSession(
  db: Queryable,
  input: {
    sessionId: string;
    nextPhase: string;
    candidatePhases: readonly string[];
  }
): Promise<void> {
  await db.query(
    `
      UPDATE jobs
      SET phase = $2::job_phase,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE session_id = $1
        AND type = 'apply_assignment'
        AND phase = ANY($3::job_phase[])
    `,
    [input.sessionId, input.nextPhase, input.candidatePhases]
  );
}

export async function updateExpiredJobLeasePhases(
  db: Queryable,
  input: {
    nextPhase: string;
    candidatePhases: readonly string[];
  }
): Promise<void> {
  await db.query(
    `
      UPDATE jobs
      SET phase = $1::job_phase,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE phase = ANY($2::job_phase[])
        AND lease_expires_at < now()
    `,
    [input.nextPhase, input.candidatePhases]
  );
}

export async function insertReconcileJob(
  db: Queryable,
  input: EnqueueReconcileJobInput & {
    initialPhase: string;
  }
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `
      INSERT INTO jobs (type, phase, gate_id, session_id, payload)
      VALUES ('reconcile', $4::job_phase, $1::uuid, $2::uuid, $3::jsonb)
      RETURNING id
    `,
    [
      input.gateId || null,
      input.sessionId || null,
      JSON.stringify({
        requestedBy: input.requestedBy,
        ...(input.reason ? { reason: input.reason } : {})
      }),
      input.initialPhase
    ]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("expected reconcile job row");
  }
  return row.id;
}
