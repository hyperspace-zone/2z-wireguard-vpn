import type { FromSchema } from "json-schema-to-ts";

export const gateAgentDeploymentPhaseValues = [
  "queued",
  "staging",
  "verifying",
  "succeeded",
  "rollback_requested",
  "rolling_back",
  "rolled_back",
  "failed"
] as const;

export const gateAgentReleaseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "version", "revision", "builtAt", "artifactSha256", "createdAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    version: { type: "string" },
    revision: { type: "string" },
    builtAt: { type: "string", format: "date-time" },
    artifactSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    createdAt: { type: "string", format: "date-time" }
  }
} as const;

export const gateAgentDeploymentSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "gateId",
    "gateName",
    "release",
    "phase",
    "requestedAt",
    "rollbackAttemptCount",
    "verificationDeadlineAt",
    "updatedAt"
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    gateId: { type: "string", format: "uuid" },
    gateName: { type: "string" },
    release: gateAgentReleaseSchema,
    phase: { enum: gateAgentDeploymentPhaseValues },
    previousAgentVersion: { type: ["string", "null"] },
    previousAgentRevision: { type: ["string", "null"] },
    previousArtifactSha256: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
    requestedAt: { type: "string", format: "date-time" },
    stagedAt: { type: ["string", "null"], format: "date-time" },
    installedAt: { type: ["string", "null"], format: "date-time" },
    verifiedAt: { type: ["string", "null"], format: "date-time" },
    rollbackRequestedAt: { type: ["string", "null"], format: "date-time" },
    rollbackAttemptCount: { type: "integer", minimum: 0, maximum: 3 },
    rolledBackAt: { type: ["string", "null"], format: "date-time" },
    failedAt: { type: ["string", "null"], format: "date-time" },
    verificationDeadlineAt: { type: "string", format: "date-time" },
    failureCode: { type: ["string", "null"] },
    failureMessage: { type: ["string", "null"] },
    updatedAt: { type: "string", format: "date-time" }
  }
} as const;

export type GateAgentRelease = FromSchema<typeof gateAgentReleaseSchema>;
export type GateAgentDeployment = FromSchema<typeof gateAgentDeploymentSchema>;
export type GateAgentDeploymentPhase = typeof gateAgentDeploymentPhaseValues[number];
