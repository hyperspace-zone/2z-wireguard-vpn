import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  adminGateCommandResponseSchema,
  adminGatesResponseSchema,
  errorResponseSchema,
  type GateDesiredState
} from "@hyperspace-zone/contracts";
import { listPublicGates, setGateDesiredState } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { AdminAuthContext } from "../../http/auth.js";
import { sendApplicationError } from "../../http/errors.js";
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
    return reply.send({ gates: await listPublicGates(deps.db, { includeNonEnabled: true }) });
  });

  registerGateDesiredStateRoute(app, deps, "enable", "Enabled");
  registerGateDesiredStateRoute(app, deps, "drain", "Draining");
  registerGateDesiredStateRoute(app, deps, "disable", "Disabled");
  registerGateDesiredStateRoute(app, deps, "maintenance", "Maintenance");
}

function registerGateDesiredStateRoute(
  app: FastifyInstance,
  deps: {
    db: Database;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => AdminAuthContext | null;
  },
  command: "enable" | "drain" | "disable" | "maintenance",
  desiredState: GateDesiredState
): void {
  app.post(`/v1/admin/gates/:gateId/${command}`, {
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

    const result = await setGateDesiredState(deps.db, admin, {
      gateId: readParam(request, "gateId"),
      desiredState
    });
    if (result === "forbidden") {
      return sendApplicationError(reply, "forbidden");
    }
    if (result === "not_found") {
      return sendApplicationError(reply, "gate_not_found");
    }
    return reply.send({ status: result });
  });
}
