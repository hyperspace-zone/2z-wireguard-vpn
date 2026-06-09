export const agentCreateSessionRequestSchema = {
  type: "object",
  additionalProperties: true,
  required: ["accountId", "mode", "destinationCidrs"],
  properties: {
    accountId: { type: "string" },
    subjectId: { type: "string" },
    mode: { enum: ["IpToIp", "FullTunnel"] },
    destinationCidrs: { type: "array", items: { type: "string" }, minItems: 1 },
    sourceCidr: { type: "string" },
    ingressGateName: { type: "string" },
    egressGateName: { type: "string" },
    clientPublicKey: { type: "string" },
    prepaidSeconds: { type: "integer", minimum: 0 }
  }
} as const;

export const agentTopUpEntitlementRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["accountId", "subjectId", "seconds"],
  properties: {
    accountId: { type: "string" },
    subjectId: { type: "string" },
    seconds: { type: "integer", minimum: 1 },
    externalPaymentId: { type: "string" }
  }
} as const;

export const agentSurfaceDisabledResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error", "message"],
  properties: {
    error: { const: "agent_surface_disabled" },
    message: { type: "string" }
  }
} as const;
