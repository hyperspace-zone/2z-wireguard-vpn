import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  tradingProbeHeartbeatRequestSchema,
  tradingProbeJobClaimRequestSchema,
  tradingProbeJobClaimResponseSchema,
  tradingProbeJobReportRequestSchema,
  type TradingProbeMetricSummary
} from "@hyperspace-zone/contracts";
import {
  claimTradingProbeJob,
  recordTradingProbeHeartbeat,
  recordTradingProbeJobReport
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { TradingProbeAuthContext } from "../../http/auth.js";
import { sendApplicationError } from "../../http/errors.js";
import { asRecord, readParam, readString, readStringArray } from "../../http/request.js";

export function registerTradingProbeAgentRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    requireTradingProbe: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<TradingProbeAuthContext | null>;
  }
): void {
  app.post("/v1/trading-probe/heartbeat", {
    schema: { body: tradingProbeHeartbeatRequestSchema }
  }, async (request, reply) => {
    const node = await deps.requireTradingProbe(request, reply);
    if (!node) return;
    const body = asRecord(request.body);
    await recordTradingProbeHeartbeat(deps.db, node, {
      bootId: readString(body, "bootId"),
      agentVersion: readString(body, "agentVersion"),
      agentRevision: readString(body, "agentRevision"),
      agentBuiltAt: readString(body, "agentBuiltAt"),
      agentArtifactSha256: readString(body, "agentArtifactSha256"),
      agentInstalledAt: readString(body, "agentInstalledAt"),
      observedEndpoint: request.ip,
      capabilities: readStringArray(body, "capabilities"),
      networkProfiles: readStringArray(body, "networkProfiles"),
      spoolDepth: readNonNegativeInteger(body, "spoolDepth"),
      selfTest: asRecord(body.selfTest)
    });
    return reply.send({ ok: true });
  });

  app.post("/v1/trading-probe/jobs/claim", {
    schema: {
      body: tradingProbeJobClaimRequestSchema,
      response: { 200: tradingProbeJobClaimResponseSchema }
    }
  }, async (request, reply) => {
    const node = await deps.requireTradingProbe(request, reply);
    if (!node) return;
    const leaseOwner = readString(asRecord(request.body), "leaseOwner");
    return reply.send({ job: await claimTradingProbeJob(deps.db, node, leaseOwner) });
  });

  app.post("/v1/trading-probe/jobs/:jobId/report", {
    schema: { body: tradingProbeJobReportRequestSchema }
  }, async (request, reply) => {
    const node = await deps.requireTradingProbe(request, reply);
    if (!node) return;
    const body = asRecord(request.body);
    const updated = await recordTradingProbeJobReport(
      deps.db,
      node,
      readParam(request, "jobId"),
      readPositiveInteger(body, "attemptNumber"),
      asRecord(body.result) as TradingProbeMetricSummary
    );
    if (!updated) return sendApplicationError(reply, "trading_probe_job_not_found");
    return reply.send({ ok: true });
  });
}

function readNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function readPositiveInteger(record: Record<string, unknown>, key: string): number {
  const value = readNonNegativeInteger(record, key);
  return value > 0 ? value : 1;
}
