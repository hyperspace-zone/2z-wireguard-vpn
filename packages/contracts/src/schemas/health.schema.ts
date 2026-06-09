import { healthResponseSchema } from "../api/health.js";

export const healthApiSchemas = {
  response: healthResponseSchema
} as const;
