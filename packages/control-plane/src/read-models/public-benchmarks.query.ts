import type { PublicGateBenchmarkMatrixResponse } from "@hyperspace-zone/contracts";
import type { Queryable } from "../db/queryable.js";
import { listLatestGateBenchmarkRoutes } from "../resources/benchmarks/repository.js";
import { listPublicGates } from "./public-gates.query.js";

export async function readPublicGateBenchmarkMatrix(
  db: Queryable
): Promise<PublicGateBenchmarkMatrixResponse> {
  const [gates, routes] = await Promise.all([
    listPublicGates(db),
    listLatestGateBenchmarkRoutes(db)
  ]);
  return {
    generatedAt: new Date().toISOString(),
    gates,
    routes
  };
}
