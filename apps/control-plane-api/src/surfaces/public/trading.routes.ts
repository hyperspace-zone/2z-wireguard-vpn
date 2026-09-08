import type { FastifyInstance } from "fastify";
import { publicTradingLatencyResponseSchema, publicTradingPairsResponseSchema, publicTradingPairsQuerySchema, publicTradingRouteResponseSchema, publicTradingUnavailableResponseSchema, type TradingPairsQuery } from "@hyperspace-zone/contracts";
import { readPublicTradingLatency, readTradingPairsSnapshot, filterTradingPairs, resolveTradingRoute, startTradingPairsRefresh } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";

export function registerPublicTradingRoutes(app: FastifyInstance, deps: { db: Database; backgroundRefresh?: boolean }): void {
  if (deps.backgroundRefresh) {
    let stop: (() => Promise<void>) | undefined;
    app.addHook("onReady", async () => { stop = startTradingPairsRefresh(deps.db, err => app.log.warn({ err }, "Trading snapshot background refresh failed")); });
    app.addHook("onClose", async () => { await stop?.(); });
  }
  app.get("/v1/public/trading/pairs", {
    schema: { querystring: publicTradingPairsQuerySchema, response: { 200: publicTradingPairsResponseSchema, 503: publicTradingUnavailableResponseSchema } }
  }, async (request, reply) => {
    // The server owns freshness; do not let browser/proxy caches relabel an
    // old snapshot as live or cache an unavailable response.
    reply.header("Cache-Control", "no-store");
    try {
      return filterTradingPairs(await readTradingPairsSnapshot(deps.db), request.query as TradingPairsQuery);
    } catch (err) {
      request.log.warn({ err }, "Trading snapshot unavailable");
      return reply.code(503).header("Retry-After", "2").send({ error: "trading_snapshot_unavailable", message: "Measurements are refreshing. Please retry shortly." });
    }
  });
  app.get<{ Params: { routeId: string } }>("/v1/public/trading/routes/:routeId", {
    schema: { params: { type: "object", required: ["routeId"], properties: { routeId: { type: "string", pattern: "^[a-f0-9]{64}$" } } }, response: { 200: publicTradingRouteResponseSchema, 503: publicTradingUnavailableResponseSchema } }
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const route = await resolveTradingRoute(deps.db, request.params.routeId);
      if (!route) return reply.code(409).send({ error: "trading_route_unavailable", message: "This route is no longer eligible. Refresh Pair Routes and choose a current route." });
      return route;
    } catch (err) {
      request.log.warn({ err }, "Trading route revalidation unavailable");
      return reply.code(503).header("Retry-After", "2").send({ error: "trading_snapshot_unavailable", message: "The route could not be revalidated. Please retry shortly." });
    }
  });
  app.get("/v1/public/trading/latency", {
    schema: { response: { 200: publicTradingLatencyResponseSchema } }
  }, async () => readPublicTradingLatency(deps.db));
}
