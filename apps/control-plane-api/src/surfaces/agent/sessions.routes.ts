import type { FastifyInstance } from "fastify";
import { agentCreateSessionRequestSchema, agentSurfaceDisabledResponseSchema } from "@hyperspace-zone/contracts";
import { createPrepaidSession } from "@hyperspace-zone/control-plane";

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
    return reply.code(503).send({ error: result.error, message: result.message });
  });
}
