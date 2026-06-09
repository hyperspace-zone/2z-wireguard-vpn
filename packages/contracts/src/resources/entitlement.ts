export const entitlementSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "accountId", "subjectId", "status", "createdAt"],
  properties: {
    id: { type: "string" },
    accountId: { type: "string" },
    subjectId: { type: "string" },
    status: { enum: ["active", "exhausted", "expired", "revoked"] },
    purchasedSeconds: { type: "integer", minimum: 0 },
    remainingSeconds: { type: "integer", minimum: 0 },
    expiresAt: { type: "string", format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" }
  }
} as const;
