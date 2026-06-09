import type { FastifyInstance } from "fastify";
import { agentSurfaceDisabledResponseSchema, agentTopUpEntitlementRequestSchema } from "@hyperspace-zone/contracts";
import { topUpEntitlement } from "@hyperspace-zone/control-plane";

export function registerAgentEntitlementRoutes(app: FastifyInstance): void {
  app.post("/v1/agent/entitlements/top-up", {
    schema: {
      body: agentTopUpEntitlementRequestSchema,
      response: {
        503: agentSurfaceDisabledResponseSchema
      }
    }
  }, async (_request, reply) => {
    const result = await topUpEntitlement();
    return reply.code(503).send({ error: result.error, message: result.message });
  });
}
