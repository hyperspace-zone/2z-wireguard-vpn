import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createTradingProbeNodeRequestSchema,
  createTradingProbeNodeResponseSchema
} from "@hyperspace-zone/contracts";
import { createTradingProbeNode } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { AdminAuthContext } from "../../http/auth.js";
import { asRecord, readString } from "../../http/request.js";

export function registerAdminTradingProbeRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    requireAdmin: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<AdminAuthContext | null>;
  }
): void {
  app.post("/v1/admin/trading/probe-nodes", {
    schema: {
      body: createTradingProbeNodeRequestSchema,
      response: { 200: createTradingProbeNodeResponseSchema }
    }
  }, async (request, reply) => {
    const admin = await deps.requireAdmin(request, reply);
    if (!admin) return;
    const body = asRecord(request.body);
    return reply.send(await createTradingProbeNode(deps.db, {
      name: readString(body, "name"),
      desiredState: readDesiredState(body.desiredState),
      placementKind: readPlacementKind(body.placementKind),
      gateName: readString(body, "gateName"),
      city: readString(body, "city"),
      country: readString(body, "country"),
      latitude: readFiniteNumber(body.latitude),
      longitude: readFiniteNumber(body.longitude),
      provider: readString(body, "provider"),
      regionCode: readString(body, "regionCode")
    }));
  });
}

function readDesiredState(value: unknown): "Enabled" | "Maintenance" | "Disabled" {
  return value === "Enabled" || value === "Disabled" ? value : "Maintenance";
}

function readPlacementKind(value: unknown): "gate_host" | "testnode" | "dedicated" {
  return value === "testnode" || value === "dedicated" ? value : "gate_host";
}

function readFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
