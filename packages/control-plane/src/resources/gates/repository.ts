import type { Queryable, TransactionalQueryable } from "../../db/queryable.js";
import { freshGateLeaseSqlPredicate, upsertGateLease } from "../gate-leases/repository.js";
import { gateHeartbeatLeaseTtlSeconds } from "../gate-leases/service.js";
import { upsertGateCondition, type GateConditionStatus } from "./conditions.js";
import type { GateDesiredState } from "./transitions.js";

interface GateHeartbeatConditionInput {
  type: string;
  status: GateConditionStatus;
  reason: string;
  message: string;
}

export interface GateHeartbeatPersistenceInput {
  gateId: string;
  gateName: string;
  generation: number;
  agentVersion: string | null;
  bootId: string | null;
  observedEndpoint: string | null;
  capabilities: string[];
  doubleZeroStatus: Record<string, unknown>;
  doubleZeroCurrentDevice: string | null;
  doubleZeroLowestLatencyDevice: string | null;
  doubleZeroLowestLatencyDeviceWarning: boolean | null;
  conditions: GateHeartbeatConditionInput[];
}

export interface SchedulableGateRow {
  id: string;
  name: string;
  publicEndpoint: string;
}

const doubleZeroGateSqlPredicate = `
  AND 'doublezero0:up' = ANY(gate_status.observed_capabilities)
  AND gate_status.doublezero_status->>'tunnelStatus' = 'BGP Session Up'
  AND gate_status.doublezero_status->>'network' = COALESCE(NULLIF(gates.spec->>'doubleZeroEnv', ''), 'testnet')
  AND gate_status.doublezero_status->>'tunnelSrc' = gates.public_endpoint
  AND ${freshGateLeaseSqlPredicate}
`;

export async function selectSchedulableGate(
  db: Queryable,
  input: {
    excludeGateId?: string;
    gateId?: string;
    gateName?: string;
  }
): Promise<SchedulableGateRow | null> {
  const result = await db.query<SchedulableGateRow>(
    `
      SELECT gates.id, gates.name, gates.public_endpoint AS "publicEndpoint"
      FROM gates
      LEFT JOIN gate_status ON gate_status.gate_id = gates.id
      LEFT JOIN gate_leases ON gate_leases.gate_id = gates.id
      LEFT JOIN gate_conditions agent ON agent.gate_id = gates.id AND agent.type = 'AgentConnected'
      LEFT JOIN gate_conditions ready ON ready.gate_id = gates.id AND ready.type = 'Ready'
      LEFT JOIN gate_conditions schedulable ON schedulable.gate_id = gates.id AND schedulable.type = 'Schedulable'
      WHERE gates.desired_state = 'Enabled'
        AND ($1::uuid IS NULL OR gates.id <> $1::uuid)
        AND COALESCE(agent.status = 'True', false)
        AND COALESCE(ready.status = 'True', false)
        AND COALESCE(schedulable.status = 'True', false)
        ${doubleZeroGateSqlPredicate}
        AND ($2::uuid IS NULL OR gates.id = $2::uuid)
        AND ($3::text IS NULL OR gates.name = $3)
      ORDER BY gates.scheduling_weight DESC, gates.name ASC
      LIMIT 1
    `,
    [
      input.excludeGateId || null,
      input.gateId || null,
      input.gateName || null
    ]
  );
  return result.rows[0] ?? null;
}

export async function updateGateDesiredState(
  db: Queryable,
  input: {
    gateId: string;
    desiredState: GateDesiredState;
    actorId: string;
  }
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `
      UPDATE gates
      SET desired_state = $2::gate_desired_state,
          generation = generation + 1,
          updated_at = now()
      WHERE id = $1
      RETURNING id
    `,
    [input.gateId, input.desiredState]
  );
  if (result.rowCount === 0) {
    return false;
  }

  await db.query(
    `
      INSERT INTO audit_events (event_type, actor_type, actor_id, gate_id, details)
      VALUES ('gate_desired_state_updated', 'admin', $1::uuid, $2, $3::jsonb)
    `,
    [
      input.actorId === "admin" ? null : input.actorId,
      input.gateId,
      JSON.stringify({ desiredState: input.desiredState })
    ]
  );
  return true;
}

export async function saveGateHeartbeat(
  db: TransactionalQueryable,
  input: GateHeartbeatPersistenceInput
): Promise<void> {
  await db.transaction(async (client) => {
    await client.query(
      `
        INSERT INTO gate_status (
          gate_id,
          observed_generation,
          agent_version,
          boot_id,
          last_seen_at,
          observed_endpoint,
          observed_capabilities,
          doublezero_status,
          doublezero_current_device,
          doublezero_lowest_latency_device,
          doublezero_lowest_latency_device_warning,
          updated_at
        )
        VALUES ($1, $2, $3, $4, now(), $5, $6::text[], $7::jsonb, $8, $9, $10, now())
        ON CONFLICT (gate_id) DO UPDATE
        SET
          observed_generation = EXCLUDED.observed_generation,
          agent_version = EXCLUDED.agent_version,
          boot_id = EXCLUDED.boot_id,
          last_seen_at = EXCLUDED.last_seen_at,
          observed_endpoint = EXCLUDED.observed_endpoint,
          observed_capabilities = EXCLUDED.observed_capabilities,
          doublezero_status = EXCLUDED.doublezero_status,
          doublezero_current_device = EXCLUDED.doublezero_current_device,
          doublezero_lowest_latency_device = EXCLUDED.doublezero_lowest_latency_device,
          doublezero_lowest_latency_device_warning = EXCLUDED.doublezero_lowest_latency_device_warning,
          updated_at = now()
      `,
      [
        input.gateId,
        input.generation,
        input.agentVersion,
        input.bootId,
        input.observedEndpoint,
        input.capabilities,
        JSON.stringify(input.doubleZeroStatus),
        input.doubleZeroCurrentDevice,
        input.doubleZeroLowestLatencyDevice,
        input.doubleZeroLowestLatencyDeviceWarning
      ]
    );
    await upsertGateLease(client, {
      gateId: input.gateId,
      leaseOwner: input.gateName,
      ttlSeconds: gateHeartbeatLeaseTtlSeconds()
    });

    for (const condition of input.conditions) {
      await upsertGateCondition(client, {
        gateId: input.gateId,
        observedGeneration: input.generation,
        ...condition
      });
    }
  });
}
