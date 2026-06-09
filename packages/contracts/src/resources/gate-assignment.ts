import type { FromSchema } from "json-schema-to-ts";

export const gateRoleValues = ["Ingress", "Egress"] as const;
export const gateAssignmentDesiredStateValues = ["Applied", "Revoked"] as const;
export const gateAssignmentPhaseValues = [
  "planned",
  "queued",
  "leased",
  "applying",
  "prepared",
  "applied",
  "drifted",
  "revoking",
  "revoked",
  "retryable_failed",
  "dead"
] as const;

export type GateRole = typeof gateRoleValues[number];
export type GateAssignmentDesiredState = typeof gateAssignmentDesiredStateValues[number];
export type GateAssignmentPhase = typeof gateAssignmentPhaseValues[number];

export const gateAssignmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "sessionId", "gateId", "role", "desiredState", "phase"],
  properties: {
    id: { type: "string" },
    sessionId: { type: "string" },
    gateId: { type: "string" },
    role: { enum: gateRoleValues },
    desiredState: { enum: gateAssignmentDesiredStateValues },
    phase: { enum: gateAssignmentPhaseValues },
    externalHandle: { type: "string" },
    observedGeneration: { type: "integer", minimum: 0 },
    localMaterial: { type: "object", additionalProperties: true },
    reportedState: { type: "object", additionalProperties: true }
  }
} as const;

export type GateAssignment = FromSchema<typeof gateAssignmentSchema>;
