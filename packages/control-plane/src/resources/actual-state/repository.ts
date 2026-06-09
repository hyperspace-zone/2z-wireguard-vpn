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
          reported_at AS "reportedAt"
        FROM gate_actual_state_snapshots
        ORDER BY gate_id, received_at DESC
      ),
      desired AS (
        SELECT
          gate_assignments.gate_id,
          array_agg(gate_assignments.external_handle ORDER BY gate_assignments.external_handle) AS "desiredHandles"
        FROM gate_assignments
        JOIN gate_assignment_status ON gate_assignment_status.assignment_id = gate_assignments.id
        WHERE gate_assignments.desired_state = 'Applied'
          AND gate_assignment_status.phase IN ('prepared', 'applied', 'drifted')
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

export async function setGateDriftCondition(
  db: Queryable,
  input: {
    gateId: string;
    drifted: boolean;
    message: string;
    details: Record<string, unknown>;
  }
): Promise<void> {
  const status = input.drifted ? "True" : "False";
  const reason = input.drifted ? "ManagedHandleDrift" : "ActualStateMatchesDesired";
  const existing = await db.query<{ status: string; reason: string; message: string }>(
    `
      SELECT status, reason, message
      FROM gate_conditions
      WHERE gate_id = $1
        AND type = 'Drift'
    `,
    [input.gateId]
  );
  const shouldAudit =
    input.drifted &&
    (!existing.rows[0] ||
      existing.rows[0].status !== status ||
      existing.rows[0].reason !== reason ||
      existing.rows[0].message !== input.message);

  await db.query(
    `
      INSERT INTO gate_conditions (
        gate_id,
        type,
        status,
        reason,
        message,
        last_transition_at
      )
      VALUES ($1, 'Drift', $2, $3, $4, now())
      ON CONFLICT (gate_id, type) DO UPDATE
      SET status = EXCLUDED.status,
          reason = EXCLUDED.reason,
          message = EXCLUDED.message,
          last_transition_at = CASE
            WHEN gate_conditions.status <> EXCLUDED.status
              OR gate_conditions.reason <> EXCLUDED.reason THEN now()
            ELSE gate_conditions.last_transition_at
      END
    `,
    [input.gateId, status, reason, input.message]
  );

  if (shouldAudit) {
    await db.query(
      `
        INSERT INTO audit_events (event_type, actor_type, gate_id, details)
        VALUES ('gate_drift_detected', 'system', $1, $2::jsonb)
      `,
      [input.gateId, JSON.stringify(input.details)]
    );
  }
}
