export const renderedPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "sessionId", "generation", "planHash", "publicMaterial", "routingModel", "firewallModel"],
  properties: {
    id: { type: "string" },
    sessionId: { type: "string" },
    generation: { type: "integer", minimum: 0 },
    planHash: { type: "string" },
    publicMaterial: { type: "object", additionalProperties: true },
    routingModel: { type: "object", additionalProperties: true },
    firewallModel: { type: "object", additionalProperties: true },
    secretRefs: { type: "object", additionalProperties: true }
  }
} as const;
