import type { AdminSessionInspection, Condition, GateAssignment, SessionSummary } from "@hyperspace-zone/contracts";
import type { Queryable } from "../db/queryable.js";

interface AdminSessionRow {
  id: string;
  mode: SessionSummary["mode"];
  desiredState: SessionSummary["desiredState"];
  phase: SessionSummary["phase"];
  label: string | null;
  destinationCidrs: string[];
  sourceCidr: string | null;
  selectedPath: Record<string, unknown> | null;
  lastError: { code?: string; message?: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface AdminAssignmentRow {
  id: string;
  sessionId: string;
  gateId: string;
  role: GateAssignment["role"];
  desiredState: GateAssignment["desiredState"];
  phase: GateAssignment["phase"];
  externalHandle: string;
  observedGeneration: number;
  localMaterial: Record<string, unknown>;
  reportedState: Record<string, unknown>;
}

interface AdminConditionRow {
  sessionId: string;
  type: string;
  status: Condition["status"];
  reason: string;
  message: string;
  observedGeneration: number;
  lastTransitionAt: string;
}

export async function listAdminSessions(db: Queryable): Promise<AdminSessionInspection[]> {
  const result = await db.query<AdminSessionRow>(
    `
      SELECT
        sessions.id,
        sessions.mode::text AS mode,
        sessions.desired_state::text AS "desiredState",
        session_status.phase::text AS phase,
        sessions.label,
        ARRAY(SELECT unnest(sessions.destination_cidrs)::text) AS "destinationCidrs",
        sessions.source_cidr::text AS "sourceCidr",
        session_status.selected_path AS "selectedPath",
        session_status.last_error AS "lastError",
        sessions.created_at AS "createdAt",
        sessions.updated_at AS "updatedAt"
      FROM sessions
      JOIN session_status ON session_status.session_id = sessions.id
      WHERE sessions.hidden_at IS NULL
      ORDER BY sessions.created_at DESC
      LIMIT 500
    `
  );
  if (result.rows.length === 0) {
    return [];
  }

  const sessionIds = result.rows.map((row) => row.id);
  const assignmentResult = await db.query<AdminAssignmentRow>(
    `
      SELECT
        gate_assignments.id,
        gate_assignments.session_id AS "sessionId",
        gate_assignments.gate_id AS "gateId",
        gate_assignments.role::text AS role,
        gate_assignments.desired_state::text AS "desiredState",
        gate_assignment_status.phase::text AS phase,
        gate_assignments.external_handle AS "externalHandle",
        gate_assignment_status.observed_generation::int AS "observedGeneration",
        gate_assignment_status.local_material AS "localMaterial",
        gate_assignment_status.reported_state AS "reportedState"
      FROM gate_assignments
      JOIN gate_assignment_status
        ON gate_assignment_status.assignment_id = gate_assignments.id
      WHERE gate_assignments.session_id = ANY($1::uuid[])
      ORDER BY gate_assignments.session_id, gate_assignments.role
    `,
    [sessionIds]
  );
  const conditionResult = await db.query<AdminConditionRow>(
    `
      SELECT
        session_id AS "sessionId",
        type,
        status,
        reason,
        COALESCE(message, '') AS message,
        COALESCE(observed_generation, 0)::int AS "observedGeneration",
        last_transition_at AS "lastTransitionAt"
      FROM session_conditions
      WHERE session_id = ANY($1::uuid[])
      ORDER BY session_id, type
    `,
    [sessionIds]
  );

  const assignmentsBySession = groupBySessionId(assignmentResult.rows, mapAdminAssignmentRow);
  const conditionsBySession = groupBySessionId(conditionResult.rows, mapAdminConditionRow);

  return result.rows.map((row) => ({
    ...mapAdminSessionRow(row),
    assignments: assignmentsBySession.get(row.id) ?? [],
    conditions: conditionsBySession.get(row.id) ?? []
  }));
}

function mapAdminSessionRow(row: AdminSessionRow): SessionSummary {
  return {
    id: row.id,
    mode: row.mode,
    desiredState: row.desiredState,
    phase: row.phase,
    ...(row.label ? { label: row.label } : {}),
    destinationCidrs: row.destinationCidrs,
    ...(row.sourceCidr ? { sourceCidr: row.sourceCidr } : {}),
    ...(row.selectedPath ? { selectedPath: row.selectedPath } : {}),
    ...(row.lastError ? { lastError: row.lastError } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapAdminAssignmentRow(row: AdminAssignmentRow): GateAssignment {
  return {
    id: row.id,
    sessionId: row.sessionId,
    gateId: row.gateId,
    role: row.role,
    desiredState: row.desiredState,
    phase: row.phase,
    externalHandle: row.externalHandle,
    observedGeneration: row.observedGeneration,
    localMaterial: row.localMaterial,
    reportedState: row.reportedState
  };
}

function mapAdminConditionRow(row: AdminConditionRow): Condition {
  return {
    type: row.type,
    status: row.status,
    reason: row.reason,
    message: row.message,
    observedGeneration: row.observedGeneration,
    lastTransitionAt: row.lastTransitionAt
  };
}

function groupBySessionId<Row extends { sessionId: string }, Value>(
  rows: Row[],
  mapRow: (row: Row) => Value
): Map<string, Value[]> {
  const grouped = new Map<string, Value[]>();
  for (const row of rows) {
    const values = grouped.get(row.sessionId) ?? [];
    values.push(mapRow(row));
    grouped.set(row.sessionId, values);
  }
  return grouped;
}
