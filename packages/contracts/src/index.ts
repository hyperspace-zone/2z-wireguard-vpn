export type ApiSurface = "public" | "agent" | "admin" | "gate";

export const apiSurfaces: Record<ApiSurface, string> = {
  public: "/v1/public",
  agent: "/v1/agent",
  admin: "/v1/admin",
  gate: "/v1/gate"
};

export * from "./api/admin.js";
export * from "./api/agent.js";
export * from "./api/gate.js";
export * from "./api/health.js";
export * from "./api/public.js";
export * from "./resources/actual-state.js";
export * from "./resources/artifact.js";
export * from "./resources/benchmark.js";
export * from "./resources/condition.js";
export * from "./resources/entitlement.js";
export * from "./resources/gate-assignment.js";
export * from "./resources/gate-agent-deployment.js";
export * from "./resources/gate-lease.js";
export * from "./resources/gate.js";
export * from "./resources/job.js";
export * from "./resources/payment.js";
export * from "./resources/probe.js";
export * from "./resources/rendered-plan.js";
export * from "./resources/session.js";
export * from "./schemas/admin.schema.js";
export * from "./schemas/agent.schema.js";
export * from "./schemas/gate.schema.js";
export * from "./schemas/health.schema.js";
export * from "./schemas/public.schema.js";
