import type { FastifyInstance } from "fastify";
import { publicGateBenchmarkMatrixResponseSchema } from "@hyperspace-zone/contracts";
import { readPublicGateBenchmarkMatrix } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";

export function registerPublicBenchmarkRoutes(app: FastifyInstance, deps: { db: Database }): void {
  app.get("/v1/public/benchmarks/gate-matrix", {
    schema: {
      response: {
        200: publicGateBenchmarkMatrixResponseSchema
      }
    }
  }, async () => readPublicGateBenchmarkMatrix(deps.db));
}
