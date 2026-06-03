export type ResourceConditionStatus = "True" | "False" | "Unknown";

export interface ResourceCondition {
  type: string;
  status: ResourceConditionStatus;
  reason: string;
  message?: string;
  observedGeneration?: number;
  lastTransitionAt: string;
}

export interface ResourceMetadata {
  id: string;
  generation: number;
  createdAt: string;
  updatedAt: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}
