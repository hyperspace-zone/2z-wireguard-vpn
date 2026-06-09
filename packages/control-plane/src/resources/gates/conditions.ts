import type { Queryable } from "../../db/queryable.js";

export const gateConditionTypes = ["AgentConnected", "Ready", "Schedulable", "Drift"] as const;

export type GateConditionStatus = "True" | "False" | "Unknown";

export interface GateConditionPersistenceInput {
  gateId: string;
  type: string;
  status: GateConditionStatus;
  reason: string;
  message: string;
  observedGeneration: number;
}

export async function upsertGateCondition(db: Queryable, input: GateConditionPersistenceInput): Promise<void> {
  await db.query(
    `
      INSERT INTO gate_conditions (
        gate_id,
        type,
        status,
        reason,
        message,
        observed_generation,
        last_transition_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (gate_id, type) DO UPDATE
      SET status = EXCLUDED.status,
          reason = EXCLUDED.reason,
          message = EXCLUDED.message,
          observed_generation = EXCLUDED.observed_generation,
          last_transition_at = CASE
            WHEN gate_conditions.status <> EXCLUDED.status THEN now()
            ELSE gate_conditions.last_transition_at
          END
    `,
    [
      input.gateId,
      input.type,
      input.status,
      input.reason,
      input.message,
      input.observedGeneration
    ]
  );
}

export async function markStaleGateConditions(db: Queryable, staleSeconds: number): Promise<void> {
  await db.query(
    `
      INSERT INTO gate_conditions (
        gate_id,
        type,
        status,
        reason,
        message,
        observed_generation,
        last_transition_at
      )
      SELECT
        gates.id,
        'AgentConnected',
        'False',
        'HeartbeatStale',
        'Gate agent heartbeat is stale',
        gates.generation,
        now()
      FROM gates
      LEFT JOIN gate_leases ON gate_leases.gate_id = gates.id
      WHERE gate_leases.lease_expires_at IS NULL
         OR gate_leases.lease_expires_at <= now()
         OR gate_leases.heartbeat_at < now() - ($1::int * interval '1 second')
      ON CONFLICT (gate_id, type) DO UPDATE
      SET status = EXCLUDED.status,
          reason = EXCLUDED.reason,
          message = EXCLUDED.message,
          observed_generation = EXCLUDED.observed_generation,
          last_transition_at = CASE
            WHEN gate_conditions.status <> EXCLUDED.status THEN now()
            ELSE gate_conditions.last_transition_at
          END
    `,
    [staleSeconds]
  );

  await db.query(
    `
      INSERT INTO gate_conditions (
        gate_id,
        type,
        status,
        reason,
        message,
        observed_generation,
        last_transition_at
      )
      SELECT
        gates.id,
        condition.type,
        'False',
        'HeartbeatStale',
        condition.message,
        gates.generation,
        now()
      FROM gates
      LEFT JOIN gate_leases ON gate_leases.gate_id = gates.id
      CROSS JOIN (
        VALUES
          ('Ready', 'Gate agent heartbeat is stale'),
          ('Schedulable', 'Gate is not eligible for new sessions while agent heartbeat is stale')
      ) AS condition(type, message)
      WHERE gate_leases.lease_expires_at IS NULL
         OR gate_leases.lease_expires_at <= now()
         OR gate_leases.heartbeat_at < now() - ($1::int * interval '1 second')
      ON CONFLICT (gate_id, type) DO UPDATE
      SET status = EXCLUDED.status,
          reason = EXCLUDED.reason,
          message = EXCLUDED.message,
          observed_generation = EXCLUDED.observed_generation,
          last_transition_at = CASE
            WHEN gate_conditions.status <> EXCLUDED.status
              OR gate_conditions.reason <> EXCLUDED.reason THEN now()
            ELSE gate_conditions.last_transition_at
          END
    `,
    [staleSeconds]
  );
}

export async function setGateDriftCondition(
  db: Queryable,
  input: {
    gateId: string;
    drifted: boolean;
    message: string;
  }
): Promise<{ changedToDrift: boolean }> {
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
  const changedToDrift =
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

  return { changedToDrift };
}
