import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { gateActualStateRequestSchema } from "@hyperspace-zone/contracts";
import { recordGateActualState } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { GateAuthContext } from "../../http/auth.js";
import { asRecord, readString, readStringArray } from "../../http/request.js";
import type { GateAssignmentCounterReport } from "@hyperspace-zone/control-plane";

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
      bootId: readString(body, "bootId"),
      agentVersion: readString(body, "agentVersion"),
      agentRevision: readString(body, "agentRevision"),
      agentBuiltAt: readString(body, "agentBuiltAt"),
      agentArtifactSha256: readString(body, "agentArtifactSha256"),
      agentInstalledAt: readString(body, "agentInstalledAt"),
      stateHash: readString(body, "stateHash"),
      managedHandles: readStringArray(body, "managedHandles"),
      assignmentCounters: readAssignmentCounters(body.assignmentCounters),
      capabilities: readStringArray(body, "capabilities"),
      diagnosticSummary: asRecord(body.diagnosticSummary ?? {}),
      reportedAt: readString(body, "reportedAt")
    });

    return reply.send({ ok: true });
  });
}

function readAssignmentCounters(value: unknown): GateAssignmentCounterReport[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => {
    const counter = asRecord(item);
    const role = readString(counter, "role");
    return {
      assignmentId: readString(counter, "assignmentId"),
      role: role === "Egress" ? "Egress" : "Ingress",
      generation: readCounter(counter, "generation"),
      sampledAt: readString(counter, "sampledAt"),
      wireGuardClientReceiveBytes: readCounter(counter, "wireGuardClientReceiveBytes"),
      wireGuardClientTransmitBytes: readCounter(counter, "wireGuardClientTransmitBytes"),
      wireGuardTransitReceiveBytes: readCounter(counter, "wireGuardTransitReceiveBytes"),
      wireGuardTransitTransmitBytes: readCounter(counter, "wireGuardTransitTransmitBytes"),
      forwardedToDestinationPackets: readCounter(counter, "forwardedToDestinationPackets"),
      forwardedToDestinationBytes: readCounter(counter, "forwardedToDestinationBytes"),
      forwardedFromDestinationPackets: readCounter(counter, "forwardedFromDestinationPackets"),
      forwardedFromDestinationBytes: readCounter(counter, "forwardedFromDestinationBytes"),
      droppedToDestinationPackets: readCounter(counter, "droppedToDestinationPackets"),
      droppedToDestinationBytes: readCounter(counter, "droppedToDestinationBytes"),
      droppedFromDestinationPackets: readCounter(counter, "droppedFromDestinationPackets"),
      droppedFromDestinationBytes: readCounter(counter, "droppedFromDestinationBytes")
    };
  });
}

function readCounter(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
