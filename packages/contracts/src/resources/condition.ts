import type { FromSchema } from "json-schema-to-ts";

export const conditionStatusValues = ["True", "False", "Unknown"] as const;

export const conditionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "status", "reason", "message", "observedGeneration"],
  properties: {
    type: { type: "string", minLength: 1 },
    status: { enum: conditionStatusValues },
    reason: { type: "string", minLength: 1 },
    message: { type: "string" },
    observedGeneration: { type: "integer", minimum: 0 },
    lastTransitionAt: { type: "string", format: "date-time" }
  }
} as const;

export type Condition = FromSchema<typeof conditionSchema>;
