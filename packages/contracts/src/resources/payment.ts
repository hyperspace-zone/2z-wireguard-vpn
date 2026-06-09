export const paymentEventSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "provider", "externalId", "eventType", "payload", "receivedAt"],
  properties: {
    id: { type: "string" },
    provider: { type: "string" },
    externalId: { type: "string" },
    eventType: { type: "string" },
    payload: { type: "object", additionalProperties: true },
    receivedAt: { type: "string", format: "date-time" }
  }
} as const;
