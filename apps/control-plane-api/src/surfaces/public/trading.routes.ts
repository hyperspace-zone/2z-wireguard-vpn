import type { FastifyInstance } from "fastify";
import { publicTradingLatencyResponseSchema, publicTradingPairsResponseSchema, publicTradingPairsQuerySchema, publicTradingRouteResponseSchema, type TradingPairsQuery } from "@hyperspace-zone/contracts";
import { readPublicTradingLatency, readTradingPairsSnapshot, filterTradingPairs, resolveTradingRoute } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";

export function registerPublicTradingRoutes(app: FastifyInstance, deps: { db: Database }): void {
  app.get("/v1/public/trading/pairs", {
    schema: { querystring: publicTradingPairsQuerySchema, response: { 200: publicTradingPairsResponseSchema } }
  }, async (request, reply) => {
    reply.header("Cache-Control", "public, max-age=10");
    return filterTradingPairs(await readTradingPairsSnapshot(deps.db), request.query as TradingPairsQuery);
  });
  app.get<{ Params: { routeId: string } }>("/v1/public/trading/routes/:routeId", {
    schema: { params: { type: "object", required: ["routeId"], properties: { routeId: { type: "string", pattern: "^[a-f0-9]{64}$" } } }, response: { 200: publicTradingRouteResponseSchema } }
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const route = await resolveTradingRoute(deps.db, request.params.routeId);
    if (!route) return reply.code(409).send({ error: "trading_route_unavailable", message: "This route is no longer eligible. Refresh Pair Routes and choose a current route." });
    return route;
  });
  app.get("/v1/public/trading/latency", {
    schema: { response: { 200: publicTradingLatencyResponseSchema } }
  }, async () => readPublicTradingLatency(deps.db));
}
