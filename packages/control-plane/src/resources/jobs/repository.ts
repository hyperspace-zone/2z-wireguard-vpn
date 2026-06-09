import type { Queryable, TransactionalQueryable } from "../../db/queryable.js";
import { mustRow } from "../../support/db.js";
import {
  appliedFromReportTransition,
  failedFromReportTransition,
  leasedAssignmentTransition,
  preparedFromReportTransition,
  revokedFromReportTransition,
  type GateAssignmentPhase
} from "../gate-assignments/transitions.js";
import {
  claimJobTransition,
  expiredLeaseCandidateJobPhases,
  expiredLeaseTransition,
  queuedJobTransition
} from "./transitions.js";

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

export interface EnqueueReconcileJobInput {
  gateId?: string;
  sessionId?: string;
  requestedBy: string;
  reason?: string;
}

export async function claimGateJobLease(
  db: TransactionalQueryable,
  gate: GateJobLeaseIdentity
): Promise<ClaimedGateJob | null> {
  return db.transaction(async (client) => {
    const job = await client.query<{
      id: string;
      type: string;
      payload: unknown;
      sessionId: string | null;
      assignmentId: string | null;
    }>(
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
      [gate.id]
    );
    const row = job.rows[0];
    if (!row) {
      return null;
    }

    const attempt = await client.query<{ attemptNumber: number }>(
      `
        SELECT COALESCE(MAX(attempt_number), 0) + 1 AS "attemptNumber"
        FROM job_attempts
        WHERE job_id = $1
      `,
      [row.id]
    );
    const attemptNumber = mustRow(attempt).attemptNumber;

    const jobTransition = claimJobTransition();
    await client.query(
      `
        UPDATE jobs
        SET phase = $2::job_phase,
            lease_owner = $3,
            lease_expires_at = now() + ($4::int * interval '1 second'),
            updated_at = now()
        WHERE id = $1
      `,
      [row.id, jobTransition.phase, gate.name, jobTransition.leaseSeconds]
    );
    await client.query(
      `
        INSERT INTO job_attempts (job_id, attempt_number, lease_owner, lease_expires_at)
        VALUES ($1, $2, $3, now() + ($4::int * interval '1 second'))
      `,
      [row.id, attemptNumber, gate.name, jobTransition.leaseSeconds]
    );
    if (row.assignmentId) {
      const assignmentStatus = await client.query<{ phase: GateAssignmentPhase }>(
        `
          SELECT phase::text AS phase
          FROM gate_assignment_status
          WHERE assignment_id = $1
          FOR UPDATE
        `,
        [row.assignmentId]
      );
      const assignmentPhase = assignmentStatus.rows[0]?.phase;
      if (!assignmentPhase) {
        throw new Error(`job ${row.id} references missing assignment ${row.assignmentId}`);
      }
      const nextAssignmentPhase = leasedAssignmentTransition(row.type, assignmentPhase);
      await client.query(
        `
          UPDATE gate_assignment_status
          SET phase = $2::gate_assignment_phase,
              updated_at = now()
          WHERE assignment_id = $1
        `,
        [row.assignmentId, nextAssignmentPhase]
      );
    }

    return {
      id: row.id,
      type: row.type,
      payload: row.payload,
      sessionId: row.sessionId,
      assignmentId: row.assignmentId,
      attemptNumber
    };
  });
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
    retryableDelay: boolean;
  }
): Promise<void> {
  const nextRunAfter = input.retryableDelay ? "now() + interval '10 seconds'" : "now()";
  await db.query(
    `
      UPDATE jobs
      SET phase = $2::job_phase,
          retry_count = CASE WHEN $2::job_phase = 'retryable_failed' THEN retry_count + 1 ELSE retry_count END,
          lease_expires_at = NULL,
          run_after = ${nextRunAfter},
          updated_at = now()
      WHERE id = $1
    `,
    [input.jobId, input.nextPhase]
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

export async function markAssignmentPreparedFromReport(
  db: Queryable,
  input: GateJobReportPersistenceInput & {
    assignmentId: string;
    material: Record<string, unknown>;
  }
): Promise<void> {
  const nextPhase = preparedFromReportTransition();
  await db.query(
    `
      UPDATE gate_assignment_status
      SET phase = $2::gate_assignment_phase,
          observed_generation = gate_assignments.generation,
          actual_state_hash = $3,
          local_material = $4::jsonb,
          reported_state = $5::jsonb,
          last_observed_at = now(),
          updated_at = now()
      FROM gate_assignments
      WHERE gate_assignment_status.assignment_id = gate_assignments.id
        AND gate_assignment_status.assignment_id = $1
    `,
    [
      input.assignmentId,
      nextPhase,
      input.actualStateHash || null,
      JSON.stringify(input.material),
      JSON.stringify(input.resultSummary)
    ]
  );
}

export async function markAssignmentAppliedFromReport(
  db: Queryable,
  input: GateJobReportPersistenceInput & {
    assignmentId: string;
  }
): Promise<void> {
  const nextPhase = appliedFromReportTransition();
  await db.query(
    `
      UPDATE gate_assignment_status
      SET phase = $2::gate_assignment_phase,
          observed_generation = gate_assignments.generation,
          applied_plan_id = gate_assignments.plan_id,
          actual_state_hash = $3,
          reported_state = $4::jsonb,
          applied_at = now(),
          last_observed_at = now(),
          updated_at = now()
      FROM gate_assignments
      WHERE gate_assignment_status.assignment_id = gate_assignments.id
        AND gate_assignment_status.assignment_id = $1
    `,
    [input.assignmentId, nextPhase, input.actualStateHash || null, JSON.stringify(input.resultSummary)]
  );
}

export async function markAssignmentRevokedFromReport(
  db: Queryable,
  input: GateJobReportPersistenceInput & {
    assignmentId: string;
  }
): Promise<void> {
  const nextPhase = revokedFromReportTransition();
  await db.query(
    `
      UPDATE gate_assignment_status
      SET phase = $2::gate_assignment_phase,
          actual_state_hash = $3,
          reported_state = $4::jsonb,
          revoked_at = now(),
          last_observed_at = now(),
          updated_at = now()
      WHERE assignment_id = $1
    `,
    [input.assignmentId, nextPhase, input.actualStateHash || null, JSON.stringify(input.resultSummary)]
  );
}

export async function markAssignmentFailedFromReport(
  db: Queryable,
  input: {
    assignmentId: string;
    terminalFailure: boolean;
    errorCode: string;
    resultSummary: Record<string, unknown>;
  }
): Promise<void> {
  const nextPhase = failedFromReportTransition(input.terminalFailure);
  await db.query(
    `
      UPDATE gate_assignment_status
      SET phase = $2::gate_assignment_phase,
          last_error = $3::jsonb,
          updated_at = now()
      WHERE assignment_id = $1
    `,
    [
      input.assignmentId,
      nextPhase,
      JSON.stringify({ errorCode: input.errorCode || "job_failed", resultSummary: input.resultSummary })
    ]
  );
}

export async function insertApplyAssignmentJob(db: Queryable, input: EnqueueApplyJobInput): Promise<void> {
  const initialPhase = queuedJobTransition();
  await db.query(
    `
      INSERT INTO jobs (type, phase, gate_id, session_id, assignment_id, payload)
      VALUES ('apply_assignment', $5::job_phase, $1, $2, $3, $4::jsonb)
      ON CONFLICT DO NOTHING
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
      initialPhase
    ]
  );
}

export async function requeueExpiredJobLeases(db: Queryable): Promise<void> {
  const nextPhase = expiredLeaseTransition("leased");
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
    [nextPhase, expiredLeaseCandidateJobPhases]
  );
}

export async function insertReconcileJob(db: Queryable, input: EnqueueReconcileJobInput): Promise<string> {
  const initialPhase = queuedJobTransition();
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
      initialPhase
    ]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("expected reconcile job row");
  }
  return row.id;
}
