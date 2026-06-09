export const gateLeaseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["gateId", "leaseOwner", "leaseExpiresAt", "heartbeatAt"],
  properties: {
    gateId: { type: "string" },
    leaseOwner: { type: "string" },
    leaseExpiresAt: { type: "string", format: "date-time" },
    heartbeatAt: { type: "string", format: "date-time" }
  }
} as const;
