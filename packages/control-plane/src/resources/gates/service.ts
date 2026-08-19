import type { TransactionalQueryable } from "../../db/queryable.js";
import { recordGateLease } from "../gate-leases/service.js";
import { saveGateHeartbeatStatus } from "./repository.js";
import { evaluateGateReadiness, readGateDoubleZeroEnv } from "./readiness.js";
import {
  resolveGateAgentConnectedCondition,
  resolveGateHeartbeatConditions,
  type GateDesiredState
} from "./transitions.js";

export interface GateRuntimeIdentity {
  id: string;
  name: string;
  generation: number;
  desiredState: GateDesiredState;
  publicIpv4: string;
  spec: Record<string, unknown>;
}

export interface GateHeartbeatReport {
  agentVersion: string;
  agentRevision?: string;
  agentBuiltAt?: string;
  agentArtifactSha256?: string;
  agentInstalledAt?: string;
  bootId: string;
  observedEndpoint: string;
  capabilities: string[];
  clockErrorMs?: number;
  doubleZero: Record<string, unknown>;
}

export async function recordGateHeartbeat(
  db: TransactionalQueryable,
  gate: GateRuntimeIdentity,
  report: GateHeartbeatReport
): Promise<void> {
  const doubleZeroCurrentDevice = readString(report.doubleZero, "currentDevice") || null;
  const doubleZeroLowestLatencyDevice = readString(report.doubleZero, "lowestLatencyDevice") || null;
  const doubleZeroLowestLatencyDeviceWarning =
    typeof report.doubleZero.lowestLatencyDeviceWarning === "boolean"
      ? report.doubleZero.lowestLatencyDeviceWarning
      : null;
  const hostReady =
    report.capabilities.includes("wireguard-tools:present") &&
    report.capabilities.includes("iproute2:present") &&
    report.capabilities.includes("nft:present");
  const readiness = evaluateGateReadiness({
    capabilities: report.capabilities,
    doubleZero: report.doubleZero,
    publicIpv4: gate.publicIpv4,
    doubleZeroEnv: readGateDoubleZeroEnv(gate.spec),
    hostReady
  });
  const lifecycleConditions = resolveGateHeartbeatConditions({
    ready: readiness.ready,
    reason: readiness.reason,
    message: readiness.message,
    doubleZeroReady: readiness.doubleZeroReady,
    doubleZeroReason: readiness.doubleZeroReason,
    doubleZeroMessage: readiness.doubleZeroMessage,
    desiredState: gate.desiredState
  });

  await db.transaction(async (client) => {
    await saveGateHeartbeatStatus(client, {
      gateId: gate.id,
      generation: gate.generation,
      agentVersion: report.agentVersion || null,
      agentRevision: report.agentRevision || null,
      agentBuiltAt: report.agentBuiltAt || null,
      agentArtifactSha256: report.agentArtifactSha256 || null,
      agentInstalledAt: report.agentInstalledAt || null,
      bootId: report.bootId || null,
      observedEndpoint: report.observedEndpoint || null,
      capabilities: report.capabilities,
      clockErrorMs: finiteNumberOrNull(report.clockErrorMs),
      doubleZeroStatus: report.doubleZero,
      doubleZeroCurrentDevice,
      doubleZeroLowestLatencyDevice,
      doubleZeroLowestLatencyDeviceWarning,
      conditions: [
        resolveGateAgentConnectedCondition(true),
        ...lifecycleConditions
      ]
    });
    await recordGateLease(client, {
      gateId: gate.id,
      leaseOwner: gate.name
    });
  });
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
