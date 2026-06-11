import type { GateSummary } from "@hyperspace-zone/contracts";
import type { Queryable } from "../db/queryable.js";
import { freshGateLeaseSqlPredicate } from "../resources/gate-leases/repository.js";

export async function listPublicGates(db: Queryable): Promise<GateSummary[]> {
  const result = await db.query<{
    id: string;
    name: string;
    desiredState: GateSummary["desiredState"];
    city: string;
    country: string;
    publicIpv4: string;
    probeUrl: string | null;
    lastSeenAt: string | null;
    doubleZero: Record<string, unknown> | null;
    doubleZeroCurrentDevice: string | null;
    doubleZeroLowestLatencyDevice: string | null;
    doubleZeroLowestLatencyDeviceWarning: boolean | null;
    agentConnected: boolean;
    ready: boolean;
    schedulable: boolean;
  }>(
    `
      SELECT
        gates.id,
        gates.name,
        gates.desired_state::text AS "desiredState",
        gates.city,
        gates.country,
        gates.public_ipv4 AS "publicIpv4",
        NULLIF(gates.spec->>'probeUrl', '') AS "probeUrl",
        gate_status.last_seen_at AS "lastSeenAt",
        gate_status.doublezero_status AS "doubleZero",
        gate_status.doublezero_current_device AS "doubleZeroCurrentDevice",
        gate_status.doublezero_lowest_latency_device AS "doubleZeroLowestLatencyDevice",
        gate_status.doublezero_lowest_latency_device_warning AS "doubleZeroLowestLatencyDeviceWarning",
        COALESCE(agent.status = 'True', false) AND ${freshGateLeaseSqlPredicate} AS "agentConnected",
        COALESCE(agent.status = 'True', false) AND ${freshGateLeaseSqlPredicate} AND COALESCE(ready.status = 'True', false) AS ready,
        gates.desired_state = 'Enabled'
          AND COALESCE(agent.status = 'True', false)
          AND ${freshGateLeaseSqlPredicate}
          AND COALESCE(schedulable.status = 'True', false) AS schedulable
      FROM gates
      LEFT JOIN gate_status ON gate_status.gate_id = gates.id
      LEFT JOIN gate_leases ON gate_leases.gate_id = gates.id
      LEFT JOIN gate_conditions agent ON agent.gate_id = gates.id AND agent.type = 'AgentConnected'
      LEFT JOIN gate_conditions ready ON ready.gate_id = gates.id AND ready.type = 'Ready'
      LEFT JOIN gate_conditions schedulable ON schedulable.gate_id = gates.id AND schedulable.type = 'Schedulable'
      ORDER BY gates.country, gates.city, gates.name
    `
  );
  return result.rows.map((row) => {
    const doubleZero = mergeGateDoubleZeroStatus({
      status: row.doubleZero,
      currentDevice: row.doubleZeroCurrentDevice,
      lowestLatencyDevice: row.doubleZeroLowestLatencyDevice,
      lowestLatencyDeviceWarning: row.doubleZeroLowestLatencyDeviceWarning
    });
    return {
      id: row.id,
      name: row.name,
      desiredState: row.desiredState,
      ...(row.city ? { city: row.city } : {}),
      ...(row.country ? { country: row.country } : {}),
      publicIpv4: row.publicIpv4,
      ...(row.probeUrl ? { probeUrl: row.probeUrl } : {}),
      ...(row.lastSeenAt ? { lastSeenAt: row.lastSeenAt } : {}),
      ...(doubleZero ? { doubleZero } : {}),
      ready: row.ready,
      schedulable: row.schedulable
    };
  });
}

function mergeGateDoubleZeroStatus(input: {
  status: Record<string, unknown> | null;
  currentDevice: string | null;
  lowestLatencyDevice: string | null;
  lowestLatencyDeviceWarning: boolean | null;
}): Record<string, unknown> | null {
  const status = input.status && Object.keys(input.status).length > 0 ? { ...input.status } : {};
  if (input.currentDevice) {
    status.currentDevice = input.currentDevice;
  }
  if (input.lowestLatencyDevice) {
    status.lowestLatencyDevice = input.lowestLatencyDevice;
  }
  if (input.lowestLatencyDeviceWarning !== null) {
    status.lowestLatencyDeviceWarning = input.lowestLatencyDeviceWarning;
  }
  return Object.keys(status).length > 0 ? status : null;
}
