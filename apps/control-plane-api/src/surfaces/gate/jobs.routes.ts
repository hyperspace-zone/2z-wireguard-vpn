import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  gateJobClaimRequestSchema,
  gateJobClaimResponseSchema,
  gateJobReportRequestSchema
} from "@hyperspace-zone/contracts";
import { claimGateJob, isJobReportStatus, recordGateJobReport, type GateJobLane } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { GateAuthContext } from "../../http/auth.js";
import { sendApplicationError } from "../../http/errors.js";
import { asRecord, readParam, readString } from "../../http/request.js";

export function registerGateJobRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    probesDb?: Database;
    requireGate: (request: FastifyRequest, reply: FastifyReply) => Promise<GateAuthContext | null>;
  }
): void {
  app.post("/v1/gate/jobs/claim", {
    schema: {
      body: gateJobClaimRequestSchema,
      response: {
        200: gateJobClaimResponseSchema
      }
    }
  }, async (request, reply) => {
    const gate = await deps.requireGate(request, reply);
    if (!gate) {
      return;
    }

    const lane = readString(asRecord(request.body), "lane") as GateJobLane | "";
    const database = lane === "probe" ? deps.probesDb ?? deps.db : deps.db;
    return reply.send({ job: await claimGateJob(database, gate, lane || (deps.probesDb ? "control" : undefined)) });
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
      return sendApplicationError(reply, "invalid_job_status");
    }

    const report = {
      status,
      actualStateHash: readString(body, "actualStateHash"),
      errorCode: readString(body, "errorCode"),
      resultSummary: asRecord(body.resultSummary ?? {})
    };
    // Existing agents do not include lane in reports. Resolve core first; a
    // successful apply/revoke report never waits for or touches probes.
    let updated = await recordGateJobReport(deps.db, gate.id, readParam(request, "jobId"), report);
    if (!updated && deps.probesDb) {
      updated = await recordGateJobReport(deps.probesDb, gate.id, readParam(request, "jobId"), report);
    }
    if (!updated) {
      return sendApplicationError(reply, "job_not_found");
    }

    return reply.send({ ok: true });
  });
}
