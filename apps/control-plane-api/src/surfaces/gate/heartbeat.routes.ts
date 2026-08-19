import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { gateAgentRuntimeResponseSchema, gateHeartbeatRequestSchema } from "@hyperspace-zone/contracts";
import { readGateAgentRuntime, recordGateHeartbeat } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { GateAuthContext } from "../../http/auth.js";
import { asRecord, detectClientIpv4, headerValue, readString, readStringArray } from "../../http/request.js";

export function registerGateHeartbeatRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    requireGate: (request: FastifyRequest, reply: FastifyReply) => Promise<GateAuthContext | null>;
  }
): void {
  app.get("/v1/gate/runtime", {
    schema: {
      response: {
        200: gateAgentRuntimeResponseSchema
      }
    }
  }, async (request, reply) => {
    const gate = await deps.requireGate(request, reply);
    if (!gate) {
      return;
    }
    return reply.send({
      gateId: gate.id,
      gateName: gate.name,
      ...(await readGateAgentRuntime(deps.db, gate.id))
    });
  });

  app.post("/v1/gate/heartbeat", {
    schema: {
      body: gateHeartbeatRequestSchema
    }
  }, async (request, reply) => {
    const gate = await deps.requireGate(request, reply);
    if (!gate) {
      return;
    }

    const body = asRecord(request.body);
    const clockErrorMs = readFiniteNumber(body, "clockErrorMs");
    const bootId = readString(body, "bootId");
    const agentVersion = readString(body, "agentVersion");
    const agentRevision = readString(body, "agentRevision");
    const agentBuiltAt = readString(body, "agentBuiltAt");
    const agentArtifactSha256 = readString(body, "agentArtifactSha256");
    const agentInstalledAt = readString(body, "agentInstalledAt");
    const observedEndpoint = readString(body, "observedEndpoint");
    const capabilities = readStringArray(body, "capabilities");
    const sourceIpv4 = detectClientIpv4(request);

    const logPayload = {
      event: "gate_heartbeat_received",
      gateId: gate.id,
      gateName: gate.name,
      gatePublicIpv4: gate.publicIpv4,
      sourceIpv4,
      sourceMatchesCatalog: sourceIpv4 ? sourceIpv4 === gate.publicIpv4 : null,
      xForwardedFor: headerValue(request, "x-forwarded-for"),
      xRealIp: headerValue(request, "x-real-ip"),
      requestIp: request.ip,
      bootId,
      agentVersion,
      agentRevision,
      agentArtifactSha256,
      observedEndpoint,
      capabilitiesCount: capabilities.length
    };
    if (sourceIpv4 && sourceIpv4 !== gate.publicIpv4) {
      request.log.warn(logPayload, "gate heartbeat source IP does not match catalog public IPv4");
    } else {
      request.log.info(logPayload, "gate heartbeat received");
    }

    await recordGateHeartbeat(deps.db, gate, {
      bootId,
      agentVersion,
      agentRevision,
      agentBuiltAt,
      agentArtifactSha256,
      agentInstalledAt,
      observedEndpoint,
      capabilities,
      ...(typeof clockErrorMs === "number" ? { clockErrorMs } : {}),
      doubleZero: asRecord(body.doubleZero)
    });

    return reply.send({ ok: true });
  });
}

function readFiniteNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
