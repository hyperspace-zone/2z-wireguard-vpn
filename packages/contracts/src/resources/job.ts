import type { FromSchema } from "json-schema-to-ts";

export const jobTypeValues = [
  "probe",
  "apply_assignment",
  "revoke_assignment",
  "cleanup_orphan",
  "reconcile",
  "deploy_agent",
  "rollback_agent"
] as const;
export const jobPhaseValues = [
  "queued",
  "leased",
  "running",
  "succeeded",
  "retryable_failed",
  "dead",
  "acknowledged_dead"
] as const;

export type JobType = typeof jobTypeValues[number];
export type JobPhase = typeof jobPhaseValues[number];

export const jobSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "phase", "payload", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string" },
    type: { enum: jobTypeValues },
    phase: { enum: jobPhaseValues },
    gateId: { type: "string" },
    sessionId: { type: "string" },
    assignmentId: { type: "string" },
    payload: { type: "object", additionalProperties: true },
    retryCount: { type: "integer", minimum: 0 },
    maxRetries: { type: "integer", minimum: 0 },
    runAfter: { type: "string", format: "date-time" },
    leaseOwner: { type: "string" },
    leaseExpiresAt: { type: "string", format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" }
  }
} as const;

export type JobSummary = FromSchema<typeof jobSchema>;
