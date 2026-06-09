import type { Queryable } from "../../db/queryable.js";
import { updateGateActualState } from "./repository.js";

export interface GateActualStateReport {
  stateHash: string;
  capabilities: string[];
  bootId: string;
  agentVersion: string;
  managedHandles: string[];
  diagnosticSummary: Record<string, unknown>;
  reportedAt: string;
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
    diagnosticSummary: report.diagnosticSummary,
    reportedAt: report.reportedAt || null
  });
}
