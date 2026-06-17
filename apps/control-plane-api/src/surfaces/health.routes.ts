import type { FastifyInstance, FastifyReply } from "fastify";
import { healthResponseSchema } from "@hyperspace-zone/contracts";
import type { Database } from "@hyperspace-zone/db";
import type { HealthRegistry, HealthSnapshot } from "@hyperspace-zone/shared";

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    health: HealthRegistry;
  }
): void {
  app.get("/health", {
    schema: {
      response: {
        200: healthResponseSchema,
        503: healthResponseSchema
      }
    }
  }, async (_request, reply) => sendHealth(reply, await healthSnapshot(deps)));

  app.get("/v1/public/health", {
    schema: {
      response: {
        200: healthResponseSchema,
        503: healthResponseSchema
      }
    }
  }, async (_request, reply) => sendHealth(reply, await healthSnapshot(deps, "public")));

  app.get("/v1/agent/health", {
    schema: {
      response: {
        200: healthResponseSchema,
        503: healthResponseSchema
      }
    }
  }, async (_request, reply) => sendHealth(reply, await healthSnapshot(deps, "agent")));

  app.get("/v1/admin/health", {
    schema: {
      response: {
        200: healthResponseSchema,
        503: healthResponseSchema
      }
    }
  }, async (_request, reply) => sendHealth(reply, await healthSnapshot(deps, "admin")));

  app.get("/v1/gate/health", {
    schema: {
      response: {
        200: healthResponseSchema,
        503: healthResponseSchema
      }
    }
  }, async (_request, reply) => sendHealth(reply, await healthSnapshot(deps, "gate")));
}

async function healthSnapshot(
  deps: {
    db: Database;
    health: HealthRegistry;
  },
  surface?: "public" | "agent" | "admin" | "gate"
): Promise<HealthSnapshot & { surface?: "public" | "agent" | "admin" | "gate" }> {
  const started = process.hrtime.bigint();
  try {
    await deps.db.query("SELECT 1");
    deps.health.setComponent("database", {
      state: "ready",
      message: "Database connection is healthy.",
      details: { latencyMs: Number(process.hrtime.bigint() - started) / 1_000_000 }
    });
  } catch (error) {
    deps.health.setComponent("database", {
      state: "failed",
      message: error instanceof Error ? error.message : String(error)
    });
  }

  return {
    ...deps.health.snapshot(),
    ...(surface ? { surface } : {})
  };
}

function sendHealth(reply: FastifyReply, snapshot: HealthSnapshot): FastifyReply {
  return reply.code(snapshot.ok ? 200 : 503).send(snapshot);
}
