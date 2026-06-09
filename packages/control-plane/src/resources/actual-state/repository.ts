import type { Queryable } from "../../db/queryable.js";

export interface GateActualStatePersistenceInput {
  stateHash: string;
  capabilities: string[];
  bootId: string | null;
  agentVersion: string | null;
  managedHandles: string[];
  diagnosticSummary: Record<string, unknown>;
  reportedAt: string | null;
}

export async function updateGateActualState(
  db: Queryable,
  gateId: string,
  input: GateActualStatePersistenceInput
): Promise<void> {
  await db.query(
    `
      INSERT INTO gate_actual_state_snapshots (
        gate_id,
        boot_id,
        agent_version,
        state_hash,
        managed_handles,
        capabilities,
        diagnostic_summary,
        reported_at
      )
      VALUES ($1, $2, $3, $4, $5::text[], $6::text[], $7::jsonb, $8::timestamptz)
    `,
    [
      gateId,
      input.bootId,
      input.agentVersion,
      input.stateHash,
      input.managedHandles,
      input.capabilities,
      JSON.stringify(input.diagnosticSummary),
      input.reportedAt
    ]
  );
  await db.query(
    `
      UPDATE gate_status
      SET actual_state_hash = $2,
          observed_capabilities = CASE WHEN cardinality($3::text[]) > 0 THEN $3::text[] ELSE observed_capabilities END,
          boot_id = COALESCE($4, boot_id),
          agent_version = COALESCE($5, agent_version),
          updated_at = now()
      WHERE gate_id = $1
    `,
    [gateId, input.stateHash || null, input.capabilities, input.bootId, input.agentVersion]
  );
}

export interface GateActualStateDriftRow {
  gateId: string;
  gateName: string;
  desiredHandles: string[];
  actualHandles: string[];
  actualStateHash: string | null;
  reportedAt: string | null;
}

export async function listGateActualStateDriftInputs(db: Queryable): Promise<GateActualStateDriftRow[]> {
  const result = await db.query<GateActualStateDriftRow>(
    `
      WITH latest_snapshot AS (
        SELECT DISTINCT ON (gate_id)
          gate_id,
          state_hash AS "actualStateHash",
          managed_handles AS "actualHandles",
          reported_at AS "reportedAt",
          received_at AS "receivedAt"
        FROM gate_actual_state_snapshots
        ORDER BY gate_id, received_at DESC
      ),
      desired AS (
        SELECT
          gate_assignments.gate_id,
          array_agg(gate_assignments.external_handle ORDER BY gate_assignments.external_handle) AS "desiredHandles"
        FROM gate_assignments
        JOIN gate_assignment_status ON gate_assignment_status.assignment_id = gate_assignments.id
        JOIN latest_snapshot ON latest_snapshot.gate_id = gate_assignments.gate_id
        WHERE gate_assignments.desired_state = 'Applied'
          AND gate_assignment_status.phase IN ('applied', 'drifted')
          AND gate_assignment_status.applied_at IS NOT NULL
          AND latest_snapshot."receivedAt" >= gate_assignment_status.applied_at
        GROUP BY gate_assignments.gate_id
      )
      SELECT
        gates.id AS "gateId",
        gates.name AS "gateName",
        COALESCE(desired."desiredHandles", '{}'::text[]) AS "desiredHandles",
        COALESCE(latest_snapshot."actualHandles", '{}'::text[]) AS "actualHandles",
        latest_snapshot."actualStateHash",
        latest_snapshot."reportedAt"
      FROM gates
      LEFT JOIN latest_snapshot ON latest_snapshot.gate_id = gates.id
      LEFT JOIN desired ON desired.gate_id = gates.id
    `
  );
  return result.rows;
}
