import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  gateJobClaimResponseSchema,
  gateJobReportRequestSchema
} from "@hyperspace-zone/contracts";
import { claimGateJob, isJobReportStatus, recordGateJobReport } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { GateAuthContext } from "../../http/auth.js";
import { asRecord, readParam, readString } from "../../http/request.js";

export function registerGateJobRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    requireGate: (request: FastifyRequest, reply: FastifyReply) => Promise<GateAuthContext | null>;
  }
): void {
  app.post("/v1/gate/jobs/claim", {
    schema: {
      response: {
        200: gateJobClaimResponseSchema
      }
    }
  }, async (request, reply) => {
    const gate = await deps.requireGate(request, reply);
    if (!gate) {
      return;
    }

    return reply.send({ job: await claimGateJob(deps.db, gate) });
  });

  app.post("/v1/gate/jobs/:jobId/report", {
    schema: {
      body: gateJobReportRequestSchema
    }
  }, async (request, reply) => {
    const gate = await deps.requireGate(request, reply);
    if (!gate) {
      return;
    }

    const body = asRecord(request.body);
    const status = readString(body, "status");
    if (!isJobReportStatus(status)) {
      return reply.code(400).send({ error: "invalid_job_status" });
    }

    const updated = await recordGateJobReport(deps.db, gate.id, readParam(request, "jobId"), {
      status,
      actualStateHash: readString(body, "actualStateHash"),
      errorCode: readString(body, "errorCode"),
      resultSummary: asRecord(body.resultSummary ?? {})
    });
    if (!updated) {
      return reply.code(404).send({ error: "job_not_found" });
    }

    return reply.send({ ok: true });
  });
}
