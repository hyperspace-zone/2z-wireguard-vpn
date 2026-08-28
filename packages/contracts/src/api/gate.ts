import type { FromSchema } from "json-schema-to-ts";
import { gateActualSnapshotSchema } from "../resources/actual-state.js";
import { gateDoubleZeroStatusSchema } from "../resources/gate.js";

export const gateHeartbeatRequestSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    bootId: { type: "string" },
    agentVersion: { type: "string" },
    agentRevision: { type: "string" },
    agentBuiltAt: { type: "string", format: "date-time" },
    agentArtifactSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    agentInstalledAt: { type: "string", format: "date-time" },
    observedEndpoint: { type: "string" },
    capabilities: { type: "array", items: { type: "string" } },
    clockErrorMs: { type: "number" },
    doubleZero: gateDoubleZeroStatusSchema
  }
} as const;

export type GateAgentHeartbeat = FromSchema<typeof gateHeartbeatRequestSchema>;

export const gateJobClaimRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    lane: { enum: ["control", "probe"] }
  }
} as const;

export type GateJobClaimRequest = FromSchema<typeof gateJobClaimRequestSchema>;

export const gateAgentRuntimeResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["gateId", "gateName", "agentVersion", "agentRevision", "agentBuiltAt", "agentArtifactSha256", "agentInstalledAt", "lastSeenAt"],
  properties: {
    gateId: { type: "string" },
    gateName: { type: "string" },
    agentVersion: { type: ["string", "null"] },
    agentRevision: { type: ["string", "null"] },
    agentBuiltAt: { type: ["string", "null"], format: "date-time" },
    agentArtifactSha256: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
    agentInstalledAt: { type: ["string", "null"], format: "date-time" },
    lastSeenAt: { type: ["string", "null"], format: "date-time" }
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
