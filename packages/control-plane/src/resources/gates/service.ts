import type { TransactionalQueryable } from "../../db/queryable.js";
import { saveGateHeartbeat } from "./repository.js";
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
  publicEndpoint: string;
  spec: Record<string, unknown>;
}

export interface GateHeartbeatReport {
  agentVersion: string;
  bootId: string;
  observedEndpoint: string;
  capabilities: string[];
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
    publicEndpoint: gate.publicEndpoint,
    doubleZeroEnv: readGateDoubleZeroEnv(gate.spec),
    hostReady
  });
  const lifecycleConditions = resolveGateHeartbeatConditions({
    ready: readiness.ready,
    reason: readiness.reason,
    message: readiness.message,
    desiredState: gate.desiredState
  });

  await saveGateHeartbeat(db, {
    gateId: gate.id,
    gateName: gate.name,
    generation: gate.generation,
    agentVersion: report.agentVersion || null,
    bootId: report.bootId || null,
    observedEndpoint: report.observedEndpoint || null,
    capabilities: report.capabilities,
    doubleZeroStatus: report.doubleZero,
    doubleZeroCurrentDevice,
    doubleZeroLowestLatencyDevice,
    doubleZeroLowestLatencyDeviceWarning,
    conditions: [
      resolveGateAgentConnectedCondition(true),
      ...lifecycleConditions
    ]
  });
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}
