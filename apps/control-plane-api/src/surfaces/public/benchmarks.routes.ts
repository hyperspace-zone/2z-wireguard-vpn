import type { FastifyInstance } from "fastify";
import { publicGateBenchmarkMatrixResponseSchema, errorResponseSchema } from "@hyperspace-zone/contracts";
import { readPublicGateBenchmarkMatrix } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { RuntimeMetrics } from "@hyperspace-zone/shared";
import { PublicReadSnapshot, publicSnapshotHeaders } from "../../http/public-read-snapshot.js";

export function registerPublicBenchmarkRoutes(app: FastifyInstance, deps: { db: Database; backgroundRefresh?: boolean; metrics?: RuntimeMetrics }): void {
  const snapshot = new PublicReadSnapshot("benchmarks", () => readPublicGateBenchmarkMatrix(deps.db), {
    ...(deps.metrics ? { metrics: deps.metrics } : {}), onFailure: () => app.log.warn("Public benchmark snapshot refresh failed; preserving bounded last-good data")
  });
  if (deps.backgroundRefresh) app.addHook("onReady", async () => snapshot.start());
  app.addHook("onClose", async () => snapshot.close());
  app.get("/v1/public/benchmarks/gate-matrix", {
    schema: {
      response: {
        200: publicGateBenchmarkMatrixResponseSchema,
        503: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    try {
      const value = await snapshot.read();
      if (publicSnapshotHeaders(request, reply, value)) return reply;
      return { ...value.data, snapshotStatus: value.state, snapshotAgeSeconds: value.ageSeconds };
    }
    catch { return reply.code(503).header("Cache-Control", "no-store").header("Retry-After", "10").send({ error: "probes_unavailable", message: "Optional measurements are temporarily unavailable." }); }
  });
}
