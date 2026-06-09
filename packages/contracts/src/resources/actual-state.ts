export const gateActualSnapshotSchema = {
  type: "object",
  additionalProperties: false,
  required: ["gateId", "bootId", "agentVersion", "managedHandles", "stateHash", "reportedAt"],
  properties: {
    gateId: { type: "string" },
    bootId: { type: "string" },
    agentVersion: { type: "string" },
    managedHandles: { type: "array", items: { type: "string" } },
    stateHash: { type: "string" },
    capabilities: { type: "array", items: { type: "string" } },
    diagnosticSummary: { type: "object", additionalProperties: true },
    reportedAt: { type: "string", format: "date-time" }
  }
} as const;
