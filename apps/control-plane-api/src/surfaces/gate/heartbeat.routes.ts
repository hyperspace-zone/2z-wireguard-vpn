import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { gateHeartbeatRequestSchema } from "@hyperspace-zone/contracts";
import { recordGateHeartbeat } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { GateAuthContext } from "../../http/auth.js";
import { asRecord, readString, readStringArray } from "../../http/request.js";

export function registerGateHeartbeatRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    requireGate: (request: FastifyRequest, reply: FastifyReply) => Promise<GateAuthContext | null>;
  }
): void {
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
    await recordGateHeartbeat(deps.db, gate, {
      bootId: readString(body, "bootId"),
      agentVersion: readString(body, "agentVersion"),
      observedEndpoint: readString(body, "observedEndpoint"),
      capabilities: readStringArray(body, "capabilities"),
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
