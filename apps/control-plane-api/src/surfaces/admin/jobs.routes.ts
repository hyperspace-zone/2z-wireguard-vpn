import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  adminForceReconcileRequestSchema,
  adminForceReconcileResponseSchema,
  adminJobsResponseSchema,
  errorResponseSchema
} from "@hyperspace-zone/contracts";
import { forceReconcile, listAdminJobs } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { AdminAuthContext } from "../../http/auth.js";
import { sendApplicationError } from "../../http/errors.js";
import { asRecord, readString } from "../../http/request.js";

export function registerAdminJobRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => AdminAuthContext | null;
  }
): void {
  app.get("/v1/admin/jobs", {
    schema: {
      response: {
        200: adminJobsResponseSchema
      }
    }
  }, async (request, reply) => {
    const admin = deps.requireAdmin(request, reply);
    if (!admin) {
      return;
    }
    return reply.send({ jobs: await listAdminJobs(deps.db) });
  });

  app.post("/v1/admin/jobs/reconcile", {
    schema: {
      body: adminForceReconcileRequestSchema,
      response: {
        202: adminForceReconcileResponseSchema,
        403: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const admin = deps.requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const body = asRecord(request.body);
    const gateId = readString(body, "gateId");
    const sessionId = readString(body, "sessionId");
    const reason = readString(body, "reason");
    const result = await forceReconcile(deps.db, admin, {
      ...(gateId ? { gateId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(reason ? { reason } : {})
    });
    if (result.status === "forbidden") {
      return sendApplicationError(reply, "forbidden");
    }
    return reply.code(202).send(result);
  });
}
