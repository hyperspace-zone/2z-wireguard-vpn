import type { Queryable } from "../../db/queryable.js";
import { updateGateActualState } from "./repository.js";

export interface GateActualStateReport {
  stateHash: string;
  capabilities: string[];
  bootId: string;
  agentVersion: string;
  managedHandles: string[];
  assignmentCounters: GateAssignmentCounterReport[];
  diagnosticSummary: Record<string, unknown>;
  reportedAt: string;
}

export interface GateAssignmentCounterReport {
  assignmentId: string;
  role: "Ingress" | "Egress";
  generation: number;
  sampledAt: string;
  wireGuardClientReceiveBytes: number;
  wireGuardClientTransmitBytes: number;
  wireGuardTransitReceiveBytes: number;
  wireGuardTransitTransmitBytes: number;
  forwardedToDestinationPackets: number;
  forwardedToDestinationBytes: number;
  forwardedFromDestinationPackets: number;
  forwardedFromDestinationBytes: number;
  droppedToDestinationPackets: number;
  droppedToDestinationBytes: number;
  droppedFromDestinationPackets: number;
  droppedFromDestinationBytes: number;
}

export async function recordGateActualState(
  db: Queryable,
  gateId: string,
  report: GateActualStateReport
): Promise<void> {
  await updateGateActualState(db, gateId, {
    stateHash: report.stateHash,
    capabilities: report.capabilities,
    bootId: report.bootId || null,
    agentVersion: report.agentVersion || null,
    managedHandles: report.managedHandles,
    assignmentCounters: report.assignmentCounters,
    diagnosticSummary: report.diagnosticSummary,
    reportedAt: report.reportedAt || null
  });
}
