import type { Queryable } from "../../db/queryable.js";
import { freshGateLeaseSqlPredicate } from "../gate-leases/repository.js";
import type { GateConditionPersistenceInput, GateConditionStatus } from "./conditions.js";

type GateDesiredState = string;

interface GateHeartbeatConditionInput {
  type: string;
  status: GateConditionStatus;
  reason: string;
  message: string;
}

export interface GateHeartbeatPersistenceInput {
  gateId: string;
  generation: number;
  agentVersion: string | null;
  agentRevision?: string | null;
  agentBuiltAt?: string | null;
  agentArtifactSha256?: string | null;
  agentInstalledAt?: string | null;
  bootId: string | null;
  observedEndpoint: string | null;
  capabilities: string[];
  clockErrorMs: number | null;
  doubleZeroStatus: Record<string, unknown>;
  doubleZeroCurrentDevice: string | null;
  doubleZeroLowestLatencyDevice: string | null;
  doubleZeroLowestLatencyDeviceWarning: boolean | null;
  conditions: GateHeartbeatConditionInput[];
}

export interface SchedulableGateRow {
  id: string;
  name: string;
  publicIpv4: string;
}

export interface GateAgentRuntimeRow {
  agentVersion: string | null;
  agentRevision: string | null;
  agentBuiltAt: string | null;
  agentArtifactSha256: string | null;
  agentInstalledAt: string | null;
  lastSeenAt: string | null;
}

export async function readGateAgentRuntime(db: Queryable, gateId: string): Promise<GateAgentRuntimeRow> {
  const result = await db.query<GateAgentRuntimeRow>(
    `
      SELECT
        agent_version AS "agentVersion",
        agent_revision AS "agentRevision",
        agent_built_at AS "agentBuiltAt",
        agent_artifact_sha256 AS "agentArtifactSha256",
        agent_installed_at AS "agentInstalledAt",
        last_seen_at AS "lastSeenAt"
      FROM gate_status
      WHERE gate_id = $1
    `,
    [gateId]
  );
  return result.rows[0] ?? {
    agentVersion: null,
    agentRevision: null,
    agentBuiltAt: null,
    agentArtifactSha256: null,
    agentInstalledAt: null,
    lastSeenAt: null
  };
}

const doubleZeroGateSqlPredicate = `
  AND 'doublezero0:up' = ANY(gate_status.observed_capabilities)
  AND gate_status.doublezero_status->>'tunnelStatus' = 'BGP Session Up'
  AND gate_status.doublezero_status->>'network' = COALESCE(NULLIF(gates.spec->>'doubleZeroEnv', ''), 'testnet')
  AND gate_status.doublezero_status->>'tunnelSrc' = gates.public_ipv4
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
      SELECT gates.id, gates.name, gates.public_ipv4 AS "publicIpv4"
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
      input.observedGeneration ?? null
    ]
  );
}

export async function markStaleGateConditions(
  db: Queryable,
  staleSeconds: number,
  conditions: ReadonlyArray<Omit<GateConditionPersistenceInput, "gateId" | "observedGeneration">>
): Promise<void> {
  for (const condition of conditions) {
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
          $2,
          $3,
          $4,
          $5,
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
              WHEN gate_conditions.status <> EXCLUDED.status
                OR gate_conditions.reason <> EXCLUDED.reason THEN now()
              ELSE gate_conditions.last_transition_at
            END
      `,
      [
        staleSeconds,
        condition.type,
        condition.status,
        condition.reason,
        condition.message
      ]
    );
  }
}

export async function setGateDriftCondition(
  db: Queryable,
  condition: GateConditionPersistenceInput
): Promise<{ changedToDrift: boolean }> {
  const existing = await db.query<{ status: string; reason: string; message: string }>(
    `
      SELECT status, reason, message
      FROM gate_conditions
      WHERE gate_id = $1
        AND type = $2
    `,
    [condition.gateId, condition.type]
  );
  const changedToDrift =
    condition.status === "True" &&
    (!existing.rows[0] ||
      existing.rows[0].status !== condition.status ||
      existing.rows[0].reason !== condition.reason ||
      existing.rows[0].message !== condition.message);

  await upsertGateCondition(db, condition);

  return { changedToDrift };
}

export async function saveGateHeartbeatStatus(
  db: Queryable,
  input: GateHeartbeatPersistenceInput
): Promise<void> {
  const previous = await db.query<{ tunnelStatus: string | null }>(
    `
      SELECT NULLIF(BTRIM(doublezero_status->>'tunnelStatus'), '') AS "tunnelStatus"
      FROM gate_status
      WHERE gate_id = $1
      FOR UPDATE
    `,
    [input.gateId]
  );
  const previousTunnelStatus = previous.rows[0]?.tunnelStatus ?? null;
  const currentTunnelStatus = normalizedStatus(input.doubleZeroStatus.tunnelStatus);

  await db.query(
    `
      INSERT INTO gate_status (
        gate_id,
        observed_generation,
        agent_version,
        agent_revision,
        agent_built_at,
        agent_artifact_sha256,
        agent_installed_at,
        boot_id,
        last_seen_at,
        observed_endpoint,
        observed_capabilities,
        clock_error_ms,
        doublezero_status,
        doublezero_current_device,
        doublezero_lowest_latency_device,
        doublezero_lowest_latency_device_warning,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7::timestamptz, $8, now(), $9, $10::text[], $11, $12::jsonb, $13, $14, $15, now())
      ON CONFLICT (gate_id) DO UPDATE
      SET
        observed_generation = EXCLUDED.observed_generation,
        agent_version = EXCLUDED.agent_version,
        agent_revision = EXCLUDED.agent_revision,
        agent_built_at = EXCLUDED.agent_built_at,
        agent_artifact_sha256 = EXCLUDED.agent_artifact_sha256,
        agent_installed_at = EXCLUDED.agent_installed_at,
        boot_id = EXCLUDED.boot_id,
        last_seen_at = EXCLUDED.last_seen_at,
        observed_endpoint = EXCLUDED.observed_endpoint,
        observed_capabilities = EXCLUDED.observed_capabilities,
        clock_error_ms = EXCLUDED.clock_error_ms,
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
      input.agentRevision ?? null,
      input.agentBuiltAt ?? null,
      input.agentArtifactSha256 ?? null,
      input.agentInstalledAt ?? null,
      input.bootId,
      input.observedEndpoint,
      input.capabilities,
      input.clockErrorMs,
      JSON.stringify(input.doubleZeroStatus),
      input.doubleZeroCurrentDevice,
      input.doubleZeroLowestLatencyDevice,
      input.doubleZeroLowestLatencyDeviceWarning
    ]
  );

  if (
    previousTunnelStatus !== null
    && currentTunnelStatus !== null
    && previousTunnelStatus !== currentTunnelStatus
  ) {
    await db.query(
      `
        INSERT INTO audit_events (event_type, actor_type, gate_id, details)
        VALUES ('gate_doublezero_tunnel_status_changed', 'system', $1, $2::jsonb)
      `,
      [
        input.gateId,
        JSON.stringify({
          previousStatus: previousTunnelStatus,
          currentStatus: currentTunnelStatus,
          network: normalizedStatus(input.doubleZeroStatus.network),
          metro: normalizedStatus(input.doubleZeroStatus.metro),
          currentDevice: normalizedStatus(input.doubleZeroStatus.currentDevice)
        })
      ]
    );
  }

  for (const condition of input.conditions) {
    await upsertGateCondition(db, {
      gateId: input.gateId,
      observedGeneration: input.generation,
      ...condition
    });
  }
}

function normalizedStatus(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}
