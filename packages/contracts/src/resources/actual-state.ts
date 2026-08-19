import type { FromSchema } from "json-schema-to-ts";

export const gateActualSnapshotSchema = {
  type: "object",
  additionalProperties: false,
  required: ["gateId", "bootId", "agentVersion", "managedHandles", "stateHash", "reportedAt"],
  properties: {
    gateId: { type: "string" },
    bootId: { type: "string" },
    agentVersion: { type: "string" },
    agentRevision: { type: "string" },
    agentBuiltAt: { type: "string", format: "date-time" },
    agentArtifactSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    agentInstalledAt: { type: "string", format: "date-time" },
    managedHandles: { type: "array", items: { type: "string" } },
    stateHash: { type: "string" },
    capabilities: { type: "array", items: { type: "string" } },
    assignmentCounters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["assignmentId", "role", "generation", "sampledAt"],
        properties: {
          assignmentId: { type: "string", format: "uuid" },
          role: { enum: ["Ingress", "Egress"] },
          generation: { type: "integer", minimum: 0 },
          sampledAt: { type: "string", format: "date-time" },
          wireGuardClientReceiveBytes: { type: "integer", minimum: 0 },
          wireGuardClientTransmitBytes: { type: "integer", minimum: 0 },
          wireGuardTransitReceiveBytes: { type: "integer", minimum: 0 },
          wireGuardTransitTransmitBytes: { type: "integer", minimum: 0 },
          forwardedToDestinationPackets: { type: "integer", minimum: 0 },
          forwardedToDestinationBytes: { type: "integer", minimum: 0 },
          forwardedFromDestinationPackets: { type: "integer", minimum: 0 },
          forwardedFromDestinationBytes: { type: "integer", minimum: 0 },
          droppedToDestinationPackets: { type: "integer", minimum: 0 },
          droppedToDestinationBytes: { type: "integer", minimum: 0 },
          droppedFromDestinationPackets: { type: "integer", minimum: 0 },
          droppedFromDestinationBytes: { type: "integer", minimum: 0 }
        }
      }
    },
    diagnosticSummary: { type: "object", additionalProperties: true },
    reportedAt: { type: "string", format: "date-time" }
  }
} as const;

export type GateActualSnapshot = FromSchema<typeof gateActualSnapshotSchema>;
