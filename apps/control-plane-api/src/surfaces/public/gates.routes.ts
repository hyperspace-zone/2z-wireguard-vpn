import type { FastifyInstance } from "fastify";
import { publicGatesResponseSchema } from "@hyperspace-zone/contracts";
import { listPublicGates } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";

export function registerPublicGatesRoutes(app: FastifyInstance, deps: { db: Database }): void {
  app.get("/v1/public/gates", {
    schema: {
      response: {
        200: publicGatesResponseSchema
      }
    }
  }, async () => ({
    gates: await listPublicGates(deps.db)
  }));
}
