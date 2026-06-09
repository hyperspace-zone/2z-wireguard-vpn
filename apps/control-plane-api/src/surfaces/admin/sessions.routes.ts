import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { adminSessionsResponseSchema } from "@hyperspace-zone/contracts";
import { listAdminSessions } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { AdminAuthContext } from "../../http/auth.js";

export function registerAdminSessionRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => AdminAuthContext | null;
  }
): void {
  app.get("/v1/admin/sessions", {
    schema: {
      response: {
        200: adminSessionsResponseSchema
      }
    }
  }, async (request, reply) => {
    const admin = deps.requireAdmin(request, reply);
    if (!admin) {
      return;
    }
    return reply.send({ sessions: await listAdminSessions(deps.db) });
  });
}
