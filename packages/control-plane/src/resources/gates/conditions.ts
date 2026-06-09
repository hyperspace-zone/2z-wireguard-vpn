export const gateConditionTypes = ["AgentConnected", "Ready", "Schedulable", "Drift"] as const;

export type GateConditionStatus = "True" | "False" | "Unknown";

export interface GateConditionPersistenceInput {
  gateId: string;
  type: string;
  status: GateConditionStatus;
  reason: string;
  message: string;
  observedGeneration?: number | null;
}

export function resolveGateDriftCondition(input: {
  gateId: string;
  drifted: boolean;
  message: string;
}): GateConditionPersistenceInput {
  return {
    gateId: input.gateId,
    type: "Drift",
    status: input.drifted ? "True" : "False",
    reason: input.drifted ? "ManagedHandleDrift" : "ActualStateMatchesDesired",
    message: input.message
  };
}
