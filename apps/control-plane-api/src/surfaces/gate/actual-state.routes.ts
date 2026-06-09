import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { gateActualStateRequestSchema } from "@hyperspace-zone/contracts";
import { recordGateActualState } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { GateAuthContext } from "../../http/auth.js";
import { asRecord, readString, readStringArray } from "../../http/request.js";

export function registerGateActualStateRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    requireGate: (request: FastifyRequest, reply: FastifyReply) => Promise<GateAuthContext | null>;
  }
): void {
  app.post("/v1/gate/actual-state", {
    schema: {
      body: gateActualStateRequestSchema
    }
  }, async (request, reply) => {
    const gate = await deps.requireGate(request, reply);
    if (!gate) {
      return;
    }

    const body = asRecord(request.body);
    await recordGateActualState(deps.db, gate.id, {
      stateHash: readString(body, "stateHash"),
      capabilities: readStringArray(body, "capabilities")
    });

    return reply.send({ ok: true });
  });
}
