import type { FastifyInstance } from "fastify";
import { agentCreateSessionRequestSchema, agentSurfaceDisabledResponseSchema } from "@hyperspace-zone/contracts";
import { createPrepaidSession } from "@hyperspace-zone/control-plane";
import { sendHttpError } from "../../http/errors.js";

export function registerAgentSessionRoutes(app: FastifyInstance): void {
  app.post("/v1/agent/sessions", {
    schema: {
      body: agentCreateSessionRequestSchema,
      response: {
        503: agentSurfaceDisabledResponseSchema
      }
    }
  }, async (_request, reply) => {
    const result = await createPrepaidSession();
    return sendHttpError(reply, 503, { error: result.error, message: result.message });
  });
}
