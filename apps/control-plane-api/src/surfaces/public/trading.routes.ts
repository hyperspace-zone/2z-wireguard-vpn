import type { FastifyInstance } from "fastify";
import { publicTradingLatencyResponseSchema } from "@hyperspace-zone/contracts";
import { readPublicTradingLatency } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";

export function registerPublicTradingRoutes(app: FastifyInstance, deps: { db: Database }): void {
  app.get("/v1/public/trading/latency", {
    schema: { response: { 200: publicTradingLatencyResponseSchema } }
  }, async () => readPublicTradingLatency(deps.db));
}
