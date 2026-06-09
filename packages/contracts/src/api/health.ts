import type { FromSchema } from "json-schema-to-ts";

export const healthResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    service: { type: "string" },
    surface: { type: "string", enum: ["public", "agent", "admin", "gate"] },
    now: { type: "string", format: "date-time" }
  }
} as const;

export type HealthResponse = FromSchema<typeof healthResponseSchema>;
