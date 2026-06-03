import Fastify from "fastify";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8080");

const app = Fastify({
  logger: true
});

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

await app.listen({ host, port });
