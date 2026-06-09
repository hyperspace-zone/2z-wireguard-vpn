import type { Queryable } from "../../db/queryable.js";
import { mustRow } from "../../support/db.js";

export interface CreateGateAssignmentInput {
  sessionId: string;
  gateId: string;
  role: "Ingress" | "Egress";
  planId: string;
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
        'Applied',
        'hs-assignment-' || generated.id::text,
        $4
      FROM generated
      ON CONFLICT (session_id, role) DO UPDATE
      SET desired_state = 'Applied',
          gate_id = EXCLUDED.gate_id,
          plan_id = EXCLUDED.plan_id,
          updated_at = now()
      RETURNING id
    `,
    [input.sessionId, input.gateId, input.role, input.planId]
  );
  return mustRow(inserted).id;
}

export async function ensureGateAssignmentQueuedStatus(db: Queryable, assignmentId: string): Promise<void> {
  await db.query(
    `
      INSERT INTO gate_assignment_status (assignment_id, phase)
      VALUES ($1, 'queued')
      ON CONFLICT (assignment_id) DO UPDATE
      SET phase = CASE
            WHEN gate_assignment_status.phase = 'applied' THEN gate_assignment_status.phase
            ELSE 'queued'
          END,
          updated_at = now()
    `,
    [assignmentId]
  );
}
