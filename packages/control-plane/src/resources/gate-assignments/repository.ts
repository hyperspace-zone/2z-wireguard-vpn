import type { Queryable } from "../../db/queryable.js";
import { mustRow } from "../../support/db.js";

type GateAssignmentPhase = string;

export interface CreateGateAssignmentInput {
  sessionId: string;
  gateId: string;
  role: "Ingress" | "Egress";
  planId: string;
  desiredState: string;
}

export interface SessionAssignmentMaterialRow {
  id: string;
  gateId: string;
  role: "Ingress" | "Egress";
  externalHandle: string;
  gateName: string;
  publicEndpoint: string;
  localMaterial: Record<string, unknown>;
}

export interface PendingAssignmentPhaseRow {
  gateName: string;
  role: "Ingress" | "Egress";
  phase: string;
}

export interface RevocableAssignmentRow {
  assignmentId: string;
  gateId: string;
  sessionId: string;
  role: "Ingress" | "Egress";
}

export interface AssignmentReportPersistenceInput {
  assignmentId: string;
  actualStateHash: string;
  errorCode: string;
  resultSummary: Record<string, unknown>;
}

export interface DriftRepairSessionRow {
  id: string;
  generation: number;
  planId: string;
  publicMaterial: Record<string, unknown>;
  routingModel: Record<string, unknown>;
  firewallModel: Record<string, unknown>;
}

export async function upsertGateAssignment(
  db: Queryable,
  input: CreateGateAssignmentInput
): Promise<string> {
  const inserted = await db.query<{ id: string }>(
    `
      WITH generated AS (
        SELECT gen_random_uuid() AS id
      )
      INSERT INTO gate_assignments (
        id,
        session_id,
        gate_id,
        role,
        desired_state,
        external_handle,
        plan_id
      )
      SELECT
        generated.id,
        $1,
        $2,
        $3::gate_assignment_role,
        $5::gate_assignment_desired_state,
        'hs-assignment-' || generated.id::text,
        $4
      FROM generated
      ON CONFLICT (session_id, role) DO UPDATE
      SET desired_state = EXCLUDED.desired_state,
          gate_id = EXCLUDED.gate_id,
          plan_id = EXCLUDED.plan_id,
          updated_at = now()
      RETURNING id
    `,
    [input.sessionId, input.gateId, input.role, input.planId, input.desiredState]
  );
  return mustRow(inserted).id;
}

export async function ensureGateAssignmentStatusPhase(
  db: Queryable,
  input: {
    assignmentId: string;
    phase: GateAssignmentPhase;
  }
): Promise<void> {
  await db.query(
    `
      INSERT INTO gate_assignment_status (assignment_id, phase)
      VALUES ($1, $2::gate_assignment_phase)
      ON CONFLICT (assignment_id) DO UPDATE
      SET phase = CASE
            WHEN gate_assignment_status.phase = 'applied' THEN gate_assignment_status.phase
            ELSE EXCLUDED.phase
          END,
          updated_at = now()
    `,
    [input.assignmentId, input.phase]
  );
}

export async function listSessionAssignmentMaterials(
  db: Queryable,
  sessionId: string
): Promise<SessionAssignmentMaterialRow[]> {
  const assignments = await db.query<SessionAssignmentMaterialRow>(
    `
      SELECT
        gate_assignments.id,
        gate_assignments.gate_id AS "gateId",
        gate_assignments.role::text AS role,
        gate_assignments.external_handle AS "externalHandle",
        gates.name AS "gateName",
        gates.public_endpoint AS "publicEndpoint",
        gate_assignment_status.local_material AS "localMaterial"
      FROM gate_assignments
      JOIN gates ON gates.id = gate_assignments.gate_id
      JOIN gate_assignment_status ON gate_assignment_status.assignment_id = gate_assignments.id
      WHERE gate_assignments.session_id = $1
      ORDER BY gate_assignments.role ASC
    `,
    [sessionId]
  );
  return assignments.rows;
}

export async function markPreparedAssignmentsQueued(
  db: Queryable,
  ingressAssignmentId: string,
  egressAssignmentId: string,
  nextPhase: GateAssignmentPhase
): Promise<void> {
  await db.query(
    `
      UPDATE gate_assignment_status
      SET phase = $3::gate_assignment_phase,
          updated_at = now()
      WHERE assignment_id IN ($1, $2)
        AND phase = 'prepared'
    `,
    [ingressAssignmentId, egressAssignmentId, nextPhase]
  );
}

export async function listAssignmentPhasesForSession(
  db: Queryable,
  sessionId: string
): Promise<PendingAssignmentPhaseRow[]> {
  const assignments = await db.query<PendingAssignmentPhaseRow>(
    `
      SELECT
        gates.name AS "gateName",
        gate_assignments.role::text AS role,
        gate_assignment_status.phase::text AS phase
      FROM gate_assignments
      JOIN gates ON gates.id = gate_assignments.gate_id
      JOIN gate_assignment_status ON gate_assignment_status.assignment_id = gate_assignments.id
      WHERE gate_assignments.session_id = $1
      ORDER BY gate_assignments.role ASC
    `,
    [sessionId]
  );
  return assignments.rows;
}

export async function markPendingAssignmentsPhaseForSession(
  db: Queryable,
  input: {
    sessionId: string;
    nextPhase: GateAssignmentPhase;
    error: Record<string, unknown>;
    candidatePhases: readonly GateAssignmentPhase[];
  }
): Promise<void> {
  await db.query(
    `
      UPDATE gate_assignment_status
      SET phase = $2::gate_assignment_phase,
          last_error = $3::jsonb,
          updated_at = now()
      FROM gate_assignments
      WHERE gate_assignment_status.assignment_id = gate_assignments.id
        AND gate_assignments.session_id = $1
        AND gate_assignment_status.phase = ANY($4::gate_assignment_phase[])
    `,
    [
      input.sessionId,
      input.nextPhase,
      JSON.stringify(input.error),
      input.candidatePhases
    ]
  );
}

export async function listAssignmentsToRevoke(db: Queryable): Promise<RevocableAssignmentRow[]> {
  const assignments = await db.query<RevocableAssignmentRow>(
    `
      SELECT
        gate_assignments.id AS "assignmentId",
        gate_assignments.gate_id AS "gateId",
        gate_assignments.session_id AS "sessionId",
        gate_assignments.role::text AS role
      FROM gate_assignments
      JOIN sessions ON sessions.id = gate_assignments.session_id
      JOIN gate_assignment_status ON gate_assignment_status.assignment_id = gate_assignments.id
      WHERE sessions.desired_state = 'Revoked'
        AND gate_assignments.desired_state <> 'Revoked'
      FOR UPDATE SKIP LOCKED
      LIMIT 100
    `
  );
  return assignments.rows;
}

export async function updateAssignmentDesiredState(
  db: Queryable,
  input: {
    assignmentId: string;
    desiredState: string;
    incrementGeneration: boolean;
  }
): Promise<void> {
  await db.query(
    `
      UPDATE gate_assignments
      SET desired_state = $2::gate_assignment_desired_state,
          generation = CASE WHEN $3::boolean THEN generation + 1 ELSE generation END,
          updated_at = now()
      WHERE id = $1
    `,
    [input.assignmentId, input.desiredState, input.incrementGeneration]
  );
}

export async function markAssignmentRevoking(
  db: Queryable,
  assignmentId: string,
  phase: GateAssignmentPhase
): Promise<void> {
  await db.query(
    `
      UPDATE gate_assignment_status
      SET phase = $2::gate_assignment_phase,
          updated_at = now()
      WHERE assignment_id = $1
        AND phase <> 'revoked'
    `,
    [assignmentId, phase]
  );
}

export async function findAssignmentPhaseForUpdate(
  db: Queryable,
  assignmentId: string
): Promise<GateAssignmentPhase | null> {
  const assignmentStatus = await db.query<{ phase: GateAssignmentPhase }>(
    `
      SELECT phase::text AS phase
      FROM gate_assignment_status
      WHERE assignment_id = $1
      FOR UPDATE
    `,
    [assignmentId]
  );
  return assignmentStatus.rows[0]?.phase ?? null;
}

export async function updateAssignmentPhase(
  db: Queryable,
  input: {
    assignmentId: string;
    phase: GateAssignmentPhase;
  }
): Promise<void> {
  await db.query(
    `
      UPDATE gate_assignment_status
      SET phase = $2::gate_assignment_phase,
          updated_at = now()
      WHERE assignment_id = $1
    `,
    [input.assignmentId, input.phase]
  );
}

export async function markAssignmentPreparedFromReport(
  db: Queryable,
  input: AssignmentReportPersistenceInput & {
    nextPhase: GateAssignmentPhase;
    material: Record<string, unknown>;
  }
): Promise<void> {
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
      input.nextPhase,
      input.actualStateHash || null,
      JSON.stringify(input.material),
      JSON.stringify(input.resultSummary)
    ]
  );
}

export async function markAssignmentAppliedFromReport(
  db: Queryable,
  input: AssignmentReportPersistenceInput & {
    nextPhase: GateAssignmentPhase;
  }
): Promise<void> {
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
    [input.assignmentId, input.nextPhase, input.actualStateHash || null, JSON.stringify(input.resultSummary)]
  );
}

export async function markAssignmentRevokedFromReport(
  db: Queryable,
  input: AssignmentReportPersistenceInput & {
    nextPhase: GateAssignmentPhase;
  }
): Promise<void> {
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
    [input.assignmentId, input.nextPhase, input.actualStateHash || null, JSON.stringify(input.resultSummary)]
  );
}

export async function markAssignmentFailedFromReport(
  db: Queryable,
  input: {
    assignmentId: string;
    nextPhase: GateAssignmentPhase;
    errorCode: string;
    resultSummary: Record<string, unknown>;
  }
): Promise<void> {
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
      input.nextPhase,
      JSON.stringify({ errorCode: input.errorCode || "job_failed", resultSummary: input.resultSummary })
    ]
  );
}

export async function markMissingHandleAssignmentRowsDrifted(
  db: Queryable,
  input: {
    gateId: string;
    missingHandles: string[];
    nextPhase: GateAssignmentPhase;
    error: Record<string, unknown>;
  }
): Promise<void> {
  if (input.missingHandles.length === 0) {
    return;
  }
  await db.query(
    `
      UPDATE gate_assignment_status
      SET phase = $3::gate_assignment_phase,
          last_error = $4::jsonb,
          updated_at = now()
      FROM gate_assignments
      WHERE gate_assignment_status.assignment_id = gate_assignments.id
        AND gate_assignments.gate_id = $1
        AND gate_assignments.external_handle = ANY($2::text[])
        AND gate_assignments.desired_state = 'Applied'
        AND gate_assignment_status.phase = 'applied'
    `,
    [
      input.gateId,
      input.missingHandles,
      input.nextPhase,
      JSON.stringify(input.error)
    ]
  );
}

export async function listMissingHandleRepairSessions(
  db: Queryable,
  gateId: string,
  missingHandles: string[]
): Promise<DriftRepairSessionRow[]> {
  if (missingHandles.length === 0) {
    return [];
  }
  const sessions = await db.query<DriftRepairSessionRow>(
    `
      SELECT
        sessions.id,
        sessions.generation::int,
        rendered_plans.id AS "planId",
        rendered_plans.public_material AS "publicMaterial",
        rendered_plans.routing_model AS "routingModel",
        rendered_plans.firewall_model AS "firewallModel"
      FROM gate_assignments target_assignment
      JOIN sessions ON sessions.id = target_assignment.session_id
      JOIN session_status ON session_status.session_id = sessions.id
      JOIN rendered_plans
        ON rendered_plans.session_id = sessions.id
       AND rendered_plans.generation = sessions.generation
      WHERE target_assignment.gate_id = $1
        AND target_assignment.external_handle = ANY($2::text[])
        AND target_assignment.desired_state = 'Applied'
        AND sessions.desired_state = 'Active'
        AND session_status.phase IN ('active', 'provisioning', 'degraded')
      ORDER BY sessions.updated_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 50
    `,
    [gateId, missingHandles]
  );
  return sessions.rows;
}

export async function listKnownOrphanAssignmentsForCleanup(
  db: Queryable,
  gateId: string,
  orphanHandles: string[]
): Promise<RevocableAssignmentRow[]> {
  if (orphanHandles.length === 0) {
    return [];
  }
  const assignments = await db.query<RevocableAssignmentRow>(
    `
      SELECT
        gate_assignments.id AS "assignmentId",
        gate_assignments.gate_id AS "gateId",
        gate_assignments.session_id AS "sessionId",
        gate_assignments.role::text AS role
      FROM gate_assignments
      JOIN gate_assignment_status ON gate_assignment_status.assignment_id = gate_assignments.id
      WHERE gate_assignments.gate_id = $1
        AND gate_assignments.external_handle = ANY($2::text[])
        AND (
          gate_assignments.desired_state = 'Revoked'
          OR gate_assignment_status.phase IN ('revoking', 'revoked', 'dead')
        )
      FOR UPDATE SKIP LOCKED
      LIMIT 100
    `,
    [gateId, orphanHandles]
  );
  return assignments.rows;
}
