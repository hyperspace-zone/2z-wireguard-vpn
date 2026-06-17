import type { FromSchema } from "json-schema-to-ts";

export const healthResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    service: { type: "string" },
    state: { type: "string", enum: ["starting", "ready", "degraded", "failed", "stopped"] },
    surface: { type: "string", enum: ["public", "agent", "admin", "gate"] },
    now: { type: "string", format: "date-time" },
    uptimeSeconds: { type: "number" },
    components: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "state", "updatedAt"],
        properties: {
          name: { type: "string" },
          state: { type: "string", enum: ["starting", "ready", "degraded", "failed", "stopped"] },
          message: { type: "string" },
          details: {
            type: "object",
            additionalProperties: true
          },
          updatedAt: { type: "string", format: "date-time" }
        }
      }
    }
  }
} as const;

export type HealthResponse = FromSchema<typeof healthResponseSchema>;
