import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  adminGateCommandResponseSchema,
  adminGatesResponseSchema,
  errorResponseSchema
} from "@hyperspace-zone/contracts";
import { drainGate, listPublicGates } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { AdminAuthContext } from "../../http/auth.js";
import { readParam } from "../../http/request.js";

export function registerAdminGatesRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => AdminAuthContext | null;
  }
): void {
  app.get("/v1/admin/gates", {
    schema: {
      response: {
        200: adminGatesResponseSchema
      }
    }
  }, async (request, reply) => {
    const admin = deps.requireAdmin(request, reply);
    if (!admin) {
      return;
    }
    return reply.send({ gates: await listPublicGates(deps.db) });
  });

  app.post("/v1/admin/gates/:gateId/drain", {
    schema: {
      response: {
        200: adminGateCommandResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const admin = deps.requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const result = await drainGate(deps.db, admin, readParam(request, "gateId"));
    if (result === "forbidden") {
      return reply.code(403).send({ error: "forbidden" });
    }
    if (result === "not_found") {
      return reply.code(404).send({ error: "gate_not_found" });
    }
    return reply.send({ status: result });
  });
}
