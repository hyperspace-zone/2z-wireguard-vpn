import type { Queryable } from "../../db/queryable.js";

export interface GateActualStatePersistenceInput {
  stateHash: string;
  capabilities: string[];
  bootId: string | null;
  agentVersion: string | null;
  agentRevision?: string | null;
  agentBuiltAt?: string | null;
  agentArtifactSha256?: string | null;
  agentInstalledAt?: string | null;
  managedHandles: string[];
  assignmentCounters: import("./snapshots.js").GateAssignmentCounterReport[];
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
          boot_id = COALESCE($3, boot_id),
          agent_version = COALESCE($4, agent_version),
          agent_revision = COALESCE($5, agent_revision),
          agent_built_at = COALESCE($6::timestamptz, agent_built_at),
          agent_artifact_sha256 = COALESCE($7, agent_artifact_sha256),
          agent_installed_at = COALESCE($8::timestamptz, agent_installed_at),
          updated_at = now()
      WHERE gate_id = $1
    `,
    [
      gateId,
      input.stateHash || null,
      input.bootId,
      input.agentVersion,
      input.agentRevision ?? null,
      input.agentBuiltAt ?? null,
      input.agentArtifactSha256 ?? null,
      input.agentInstalledAt ?? null
    ]
  );
  for (const counter of input.assignmentCounters) {
    await recordGateAssignmentCounter(db, gateId, input.bootId, counter);
  }
}

async function recordGateAssignmentCounter(
  db: Queryable,
  gateId: string,
  bootId: string | null,
  counter: import("./snapshots.js").GateAssignmentCounterReport
): Promise<void> {
  if (!bootId) {
    return;
  }
  const values = [
    counter.wireGuardClientReceiveBytes,
    counter.wireGuardClientTransmitBytes,
    counter.wireGuardTransitReceiveBytes,
    counter.wireGuardTransitTransmitBytes,
    counter.forwardedToDestinationPackets,
    counter.forwardedToDestinationBytes,
    counter.forwardedFromDestinationPackets,
    counter.forwardedFromDestinationBytes,
    counter.droppedToDestinationPackets,
    counter.droppedToDestinationBytes,
    counter.droppedFromDestinationPackets,
    counter.droppedFromDestinationBytes
  ].map((value) => String(Math.max(0, Math.trunc(Number(value) || 0))));

  await db.query(
    `
      WITH target AS (
        SELECT gate_assignments.id
        FROM gate_assignments
        WHERE gate_assignments.id = $2::uuid
          AND gate_assignments.gate_id = $1::uuid
      ),
      previous AS (
        SELECT gate_assignment_counter_samples.*
        FROM gate_assignment_counter_samples
        JOIN target ON target.id = gate_assignment_counter_samples.assignment_id
        WHERE gate_assignment_counter_samples.gate_id = $1::uuid
          AND gate_assignment_counter_samples.boot_id = $3
          AND gate_assignment_counter_samples.generation = $4
          AND gate_assignment_counter_samples.sampled_at < $6::timestamptz
        ORDER BY gate_assignment_counter_samples.sampled_at DESC
        LIMIT 1
      ),
      inserted AS (
        INSERT INTO gate_assignment_counter_samples (
          gate_id, assignment_id, boot_id, generation, role, sampled_at,
          wireguard_client_receive_bytes, wireguard_client_transmit_bytes,
          wireguard_transit_receive_bytes, wireguard_transit_transmit_bytes,
          forwarded_to_destination_packets, forwarded_to_destination_bytes,
          forwarded_from_destination_packets, forwarded_from_destination_bytes,
          dropped_to_destination_packets, dropped_to_destination_bytes,
          dropped_from_destination_packets, dropped_from_destination_bytes
        )
        SELECT
          $1::uuid, target.id, $3, $4, $5, $6::timestamptz,
          $7::bigint, $8::bigint, $9::bigint, $10::bigint,
          $11::bigint, $12::bigint, $13::bigint, $14::bigint,
          $15::bigint, $16::bigint, $17::bigint, $18::bigint
        FROM target
        ON CONFLICT (gate_id, assignment_id, boot_id, generation, sampled_at) DO NOTHING
        RETURNING *
      )
      INSERT INTO gate_assignment_usage_deltas (
        sample_id, gate_id, assignment_id, boot_id, generation, role, window_start, window_end,
        wireguard_client_receive_bytes, wireguard_client_transmit_bytes,
        wireguard_transit_receive_bytes, wireguard_transit_transmit_bytes,
        forwarded_to_destination_packets, forwarded_to_destination_bytes,
        forwarded_from_destination_packets, forwarded_from_destination_bytes,
        dropped_to_destination_packets, dropped_to_destination_bytes,
        dropped_from_destination_packets, dropped_from_destination_bytes
      )
      SELECT
        inserted.id, inserted.gate_id, inserted.assignment_id, inserted.boot_id, inserted.generation,
        inserted.role, COALESCE(previous.sampled_at, inserted.sampled_at), inserted.sampled_at,
        GREATEST(inserted.wireguard_client_receive_bytes - COALESCE(previous.wireguard_client_receive_bytes, inserted.wireguard_client_receive_bytes), 0),
        GREATEST(inserted.wireguard_client_transmit_bytes - COALESCE(previous.wireguard_client_transmit_bytes, inserted.wireguard_client_transmit_bytes), 0),
        GREATEST(inserted.wireguard_transit_receive_bytes - COALESCE(previous.wireguard_transit_receive_bytes, inserted.wireguard_transit_receive_bytes), 0),
        GREATEST(inserted.wireguard_transit_transmit_bytes - COALESCE(previous.wireguard_transit_transmit_bytes, inserted.wireguard_transit_transmit_bytes), 0),
        GREATEST(inserted.forwarded_to_destination_packets - COALESCE(previous.forwarded_to_destination_packets, inserted.forwarded_to_destination_packets), 0),
        GREATEST(inserted.forwarded_to_destination_bytes - COALESCE(previous.forwarded_to_destination_bytes, inserted.forwarded_to_destination_bytes), 0),
        GREATEST(inserted.forwarded_from_destination_packets - COALESCE(previous.forwarded_from_destination_packets, inserted.forwarded_from_destination_packets), 0),
        GREATEST(inserted.forwarded_from_destination_bytes - COALESCE(previous.forwarded_from_destination_bytes, inserted.forwarded_from_destination_bytes), 0),
        GREATEST(inserted.dropped_to_destination_packets - COALESCE(previous.dropped_to_destination_packets, inserted.dropped_to_destination_packets), 0),
        GREATEST(inserted.dropped_to_destination_bytes - COALESCE(previous.dropped_to_destination_bytes, inserted.dropped_to_destination_bytes), 0),
        GREATEST(inserted.dropped_from_destination_packets - COALESCE(previous.dropped_from_destination_packets, inserted.dropped_from_destination_packets), 0),
        GREATEST(inserted.dropped_from_destination_bytes - COALESCE(previous.dropped_from_destination_bytes, inserted.dropped_from_destination_bytes), 0)
      FROM inserted
      LEFT JOIN previous ON true
      ON CONFLICT (sample_id) DO NOTHING
    `,
    [gateId, counter.assignmentId, bootId, counter.generation, counter.role, counter.sampledAt, ...values]
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

export async function deleteExpiredGateActualStateSnapshots(
  db: Queryable,
  retentionHours = 24,
  batchSize = 1_000
): Promise<number> {
  const result = await db.query(
    `
      WITH expired AS (
        SELECT id
        FROM gate_actual_state_snapshots
        WHERE received_at < now() - make_interval(hours => $1::int)
        ORDER BY received_at
        LIMIT $2::int
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM gate_actual_state_snapshots snapshots
      USING expired
      WHERE snapshots.id = expired.id
    `,
    [retentionHours, batchSize]
  );
  return result.rowCount ?? 0;
}

export async function listGateActualStateDriftInputs(db: Queryable): Promise<GateActualStateDriftRow[]> {
  const result = await db.query<GateActualStateDriftRow>(
    `
      WITH desired AS (
        SELECT
          gate_assignments.gate_id,
          array_agg(gate_assignments.external_handle ORDER BY gate_assignments.external_handle) AS "desiredHandles"
        FROM gate_assignments
        JOIN gate_assignment_status ON gate_assignment_status.assignment_id = gate_assignments.id
        JOIN LATERAL (
          SELECT received_at AS "receivedAt"
          FROM gate_actual_state_snapshots
          WHERE gate_actual_state_snapshots.gate_id = gate_assignments.gate_id
          ORDER BY received_at DESC
          LIMIT 1
        ) latest_snapshot ON true
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
      LEFT JOIN LATERAL (
        SELECT
          state_hash AS "actualStateHash",
          managed_handles AS "actualHandles",
          reported_at AS "reportedAt"
        FROM gate_actual_state_snapshots
        WHERE gate_actual_state_snapshots.gate_id = gates.id
        ORDER BY received_at DESC
        LIMIT 1
      ) latest_snapshot ON true
      LEFT JOIN desired ON desired.gate_id = gates.id
    `
  );
  return result.rows;
}
