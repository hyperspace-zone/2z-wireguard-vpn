import type { FastifyInstance } from "fastify";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/health", async () => ({
    ok: true,
    service: "control-plane-api",
    now: new Date().toISOString()
  }));

  app.get("/v1/public/health", async () => ({
    ok: true,
    surface: "public"
  }));

  app.get("/v1/agent/health", async () => ({
    ok: true,
    surface: "agent"
  }));

  app.get("/v1/admin/health", async () => ({
    ok: true,
    surface: "admin"
  }));

  app.get("/v1/gate/health", async () => ({
    ok: true,
    surface: "gate"
  }));
}
