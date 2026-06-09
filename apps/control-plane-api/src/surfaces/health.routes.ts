import type { FastifyInstance } from "fastify";
import { healthResponseSchema } from "@hyperspace-zone/contracts";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/health", {
    schema: {
      response: {
        200: healthResponseSchema
      }
    }
  }, async () => ({
    ok: true,
    service: "control-plane-api",
    now: new Date().toISOString()
  }));

  app.get("/v1/public/health", {
    schema: {
      response: {
        200: healthResponseSchema
      }
    }
  }, async () => ({
    ok: true,
    surface: "public"
  }));

  app.get("/v1/agent/health", {
    schema: {
      response: {
        200: healthResponseSchema
      }
    }
  }, async () => ({
    ok: true,
    surface: "agent"
  }));

  app.get("/v1/admin/health", {
    schema: {
      response: {
        200: healthResponseSchema
      }
    }
  }, async () => ({
    ok: true,
    surface: "admin"
  }));

  app.get("/v1/gate/health", {
    schema: {
      response: {
        200: healthResponseSchema
      }
    }
  }, async () => ({
    ok: true,
    surface: "gate"
  }));
}
