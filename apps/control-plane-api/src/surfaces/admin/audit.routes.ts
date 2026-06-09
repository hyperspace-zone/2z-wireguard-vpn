import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { adminAuditEventsResponseSchema } from "@hyperspace-zone/contracts";
import { listAuditEvents } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { AdminAuthContext } from "../../http/auth.js";

export function registerAdminAuditRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => AdminAuthContext | null;
  }
): void {
  app.get("/v1/admin/audit", {
    schema: {
      response: {
        200: adminAuditEventsResponseSchema
      }
    }
  }, async (request, reply) => {
    const admin = deps.requireAdmin(request, reply);
    if (!admin) {
      return;
    }
    return reply.send({ events: await listAuditEvents(deps.db) });
  });
}
