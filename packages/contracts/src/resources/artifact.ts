export const artifactPhaseValues = ["prepared", "available", "downloaded", "invalidated"] as const;

export const artifactSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "sessionId", "artifactType", "phase", "createdAt"],
  properties: {
    id: { type: "string" },
    sessionId: { type: "string" },
    artifactType: { type: "string" },
    phase: { enum: artifactPhaseValues },
    publicPayload: { type: "object", additionalProperties: true },
    encryptedPayloadRef: { type: "string" },
    issuedAt: { type: "string", format: "date-time" },
    downloadedAt: { type: "string", format: "date-time" },
    invalidatedAt: { type: "string", format: "date-time" },
    createdAt: { type: "string", format: "date-time" }
  }
} as const;
