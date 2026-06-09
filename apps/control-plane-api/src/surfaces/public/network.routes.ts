import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { publicNetworkMeResponseSchema } from "@hyperspace-zone/contracts";
import type { PublicAuthUser } from "../../http/auth.js";
import { detectClientIpv4 } from "../../http/request.js";

export function registerPublicNetworkRoutes(
  app: FastifyInstance,
  deps: {
    requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<PublicAuthUser | null>;
  }
): void {
  app.get("/v1/public/network/me", {
    schema: {
      response: {
        200: publicNetworkMeResponseSchema
      }
    }
  }, async (request, reply) => {
    const user = await deps.requireUser(request, reply);
    if (!user) {
      return;
    }
    return reply.send({ ip: detectClientIpv4(request) });
  });
}
