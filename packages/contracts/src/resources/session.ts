export const sessionModeValues = ["IpToIp", "FullTunnel"] as const;
export const desiredSessionStateValues = ["Active", "Revoked"] as const;
export const sessionPhaseValues = [
  "requested",
  "probing",
  "scheduling",
  "provisioning",
  "active",
  "degraded",
  "revoking",
  "revoked",
  "failed"
] as const;

export const sessionSpecSchema = {
  type: "object",
  additionalProperties: false,
  required: ["desiredState", "mode", "destinationCidrs"],
  properties: {
    desiredState: { enum: desiredSessionStateValues },
    mode: { enum: sessionModeValues },
    destinationCidrs: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
    sourceCidr: { type: "string", minLength: 1 },
    ingressGateId: { type: "string", minLength: 1 },
    egressGateId: { type: "string", minLength: 1 },
    ingressGateName: { type: "string", minLength: 1 },
    egressGateName: { type: "string", minLength: 1 },
    clientPublicKey: { type: "string", minLength: 44, maxLength: 44 },
    pathPolicy: { type: "object", additionalProperties: true },
    artifactPolicy: { type: "object", additionalProperties: true }
  }
} as const;

export const sessionSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "mode", "desiredState", "phase", "destinationCidrs", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string" },
    mode: { enum: sessionModeValues },
    desiredState: { enum: desiredSessionStateValues },
    phase: { enum: sessionPhaseValues },
    label: { type: "string" },
    destinationCidrs: { type: "array", items: { type: "string" } },
    sourceCidr: { type: "string" },
    selectedPath: { type: "object", additionalProperties: true },
    lastError: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: { type: "string" },
        message: { type: "string" }
      }
    },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" }
  }
} as const;
