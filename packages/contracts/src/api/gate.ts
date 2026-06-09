import { gateActualSnapshotSchema } from "../resources/actual-state.js";
import { gateDoubleZeroStatusSchema } from "../resources/gate.js";

export const gateHeartbeatRequestSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    bootId: { type: "string" },
    agentVersion: { type: "string" },
    observedEndpoint: { type: "string" },
    capabilities: { type: "array", items: { type: "string" } },
    doubleZero: gateDoubleZeroStatusSchema
  }
} as const;

export const gateActualStateRequestSchema = {
  ...gateActualSnapshotSchema
} as const;

export const gateJobClaimResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["job"],
  properties: {
    job: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["id", "type", "payload", "attemptNumber"],
          properties: {
            id: { type: "string" },
            type: { type: "string" },
            payload: { type: "object", additionalProperties: true },
            sessionId: { type: ["string", "null"] },
            assignmentId: { type: ["string", "null"] },
            attemptNumber: { type: "integer", minimum: 1 }
          }
        }
      ]
    }
  }
} as const;

export const gateJobReportRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { enum: ["succeeded", "retryable_failed", "failed"] },
    actualStateHash: { type: "string" },
    errorCode: { type: "string" },
    resultSummary: { type: "object", additionalProperties: true }
  }
} as const;
