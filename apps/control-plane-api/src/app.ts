import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import {
  readSolanaNativeBalance,
  type BillingConfig,
  type GoogleOAuthConfig,
  type SessionAbuseControlConfig
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import {
  createHealthRegistry,
  createRuntimeMetrics,
  type HealthRegistry,
  type RuntimeMetrics
} from "@hyperspace-zone/shared";
import { createHttpAuth } from "./http/auth.js";
import { registerOpenApiRoute } from "./http/openapi.js";
import { registerPublicRateLimits, type PublicRateLimitConfig } from "./http/rate-limit.js";
import { registerAuthAudit } from "./http/auth-audit.js";
import type { EmailAuthProtectionConfig } from "./services/email-auth-protection.js";
import { registerAdminAuditRoutes } from "./surfaces/admin/audit.routes.js";
import { registerAdminBillingRoutes } from "./surfaces/admin/billing.routes.js";
import { registerAdminGatesRoutes } from "./surfaces/admin/gates.routes.js";
import { registerGateAgentDeploymentRoutes } from "./surfaces/admin/gate-agent-deployments.routes.js";
import { registerAdminJobRoutes } from "./surfaces/admin/jobs.routes.js";
import { registerAdminSessionRoutes } from "./surfaces/admin/sessions.routes.js";
import { registerAdminTradingProbeRoutes } from "./surfaces/admin/trading-probes.routes.js";
import { registerAgentEntitlementRoutes } from "./surfaces/agent/entitlements.routes.js";
import { registerAgentSessionRoutes } from "./surfaces/agent/sessions.routes.js";
import { registerGateActualStateRoutes } from "./surfaces/gate/actual-state.routes.js";
import { registerGateHeartbeatRoutes } from "./surfaces/gate/heartbeat.routes.js";
import { registerGateJobRoutes } from "./surfaces/gate/jobs.routes.js";
import { registerHealthRoutes } from "./surfaces/health.routes.js";
import { registerPublicArtifactRoutes } from "./surfaces/public/artifacts.routes.js";
import { registerPublicAuthRoutes } from "./surfaces/public/auth.routes.js";
import { registerPublicBenchmarkRoutes } from "./surfaces/public/benchmarks.routes.js";
import { registerPublicBillingRoutes } from "./surfaces/public/billing.routes.js";
import { registerPublicGatesRoutes } from "./surfaces/public/gates.routes.js";
import { registerPublicNetworkRoutes } from "./surfaces/public/network.routes.js";
import { registerPublicSessionsRoutes } from "./surfaces/public/sessions.routes.js";
import { registerPublicTradingRoutes } from "./surfaces/public/trading.routes.js";
import { registerTradingProbeAgentRoutes } from "./surfaces/trading-probe/agent.routes.js";
import {
  createSolanaConfigPaymentService,
  type SolanaConfigPaymentService
} from "./services/solana-config-payment.js";

export interface ControlPlaneApiRuntimeConfig {
  trustedProxyCidrs: string[];
  emailAuthProtection: EmailAuthProtectionConfig;
  authSessionTtlSeconds: number;
  downloadTokenTtlSeconds: number;
  adminToken?: string;
  billingAdminEmails: string[];
  artifactEncryptionKey: Buffer | null;
  gateAgentReleaseDir: string;
  publicRateLimit: PublicRateLimitConfig;
  selfServiceAbuseControls: SessionAbuseControlConfig;
  emailAuth: {
    provider: "console" | "resend";
    resendApiKey: string;
    from: string;
    replyTo: string;
    otpHashSecret: string;
    otpTtlSeconds: number;
    exposeCodes: boolean;
  };
  googleOAuth: GoogleOAuthConfig | null;
  walletAuth: {
    custodialEncryptionKey: Buffer | null;
  };
  billing: BillingConfig & {
    enforcePositiveBalance: boolean;
    requiredMinBalanceMinor: number;
  };
}

export interface CreateControlPlaneApiAppInput {
  db: Database;
  benchmarkDb?: Database;
  config: ControlPlaneApiRuntimeConfig;
  health?: HealthRegistry;
  metrics?: RuntimeMetrics;
  configPaymentService?: SolanaConfigPaymentService | null;
}

export function createApp(input: CreateControlPlaneApiAppInput): FastifyInstance {
  const { db, config } = input;
  const benchmarkDb = input.benchmarkDb ?? db;
  const auth = createHttpAuth({
    db,
    adminToken: config.adminToken,
    billingAdminEmails: config.billingAdminEmails
  });
  const health = input.health ?? createHealthRegistry("control-plane-api");
  const metrics = input.metrics ?? createRuntimeMetrics({ service: "control-plane-api" });
  const treasuryAddress = config.billing.configPaymentTreasuryAddress ?? "";
  const solanaRpcUrl = config.billing.solanaRpcUrl;
  const configPaymentService = input.configPaymentService !== undefined
    ? input.configPaymentService
    : config.billing.configPaymentEnabled &&
      config.billing.solanaAssetKind === "native" &&
      config.billing.solanaRpcUrl &&
      config.billing.configPaymentTreasuryAddress &&
      config.billing.configPriceLamports &&
      config.walletAuth.custodialEncryptionKey
      ? createSolanaConfigPaymentService({
        db,
        rpcUrl: config.billing.solanaRpcUrl,
        treasuryAddress: config.billing.configPaymentTreasuryAddress,
        amountLamports: config.billing.configPriceLamports,
        trafficLimitBytes: config.billing.configTrafficLimitBytes ?? 50_000_000_000,
        custodialEncryptionKey: config.walletAuth.custodialEncryptionKey
      })
      : null;
  health.setComponent("process", { state: "starting", message: "Fastify app is being created." });
  health.setComponent("configuration", { state: "ready", message: "Runtime configuration loaded." });

  const app = Fastify({
    trustProxy: config.trustedProxyCidrs,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    disableRequestLogging: true,
    logger: {
      serializers: {
        req: serializeRequestForLog
      }
    }
  });
  app.addHook("onClose", async () => {
    metrics.stop();
  });

  registerRuntimeMetricsHooks(app, metrics);
  registerAuthAudit(app, config.emailAuth.otpHashSecret, metrics);
  registerPublicRateLimits(app, config.publicRateLimit, metrics);
  registerOpenApiRoute(app);
  registerHealthRoutes(app, { db, health });
  registerPublicAuthRoutes(app, {
    db,
    authSessionTtlSeconds: config.authSessionTtlSeconds,
    emailAuth: config.emailAuth,
    protection: config.emailAuthProtection,
    metrics,
    googleOAuth: config.googleOAuth,
    requireUser: auth.requireUser,
    hasBillingAdminAccess: auth.hasBillingAdminAccess
  });
  registerPublicBenchmarkRoutes(app, { db: benchmarkDb });
  registerPublicTradingRoutes(app, { db: benchmarkDb, pageDb: db, backgroundRefresh: Boolean(input.benchmarkDb) });
  registerPublicGatesRoutes(app, { db });
  registerPublicNetworkRoutes(app, { requireUser: auth.requireUser });
  registerPublicBillingRoutes(app, {
    db,
    requireUser: auth.requireUser,
    billing: config.billing,
    custodialEncryptionKey: config.walletAuth.custodialEncryptionKey
  });
  registerPublicSessionsRoutes(app, {
    db,
    requireUser: auth.requireUser,
    billing: config.billing,
    configPaymentService,
    selfServiceAbuseControls: config.selfServiceAbuseControls
  });
  registerPublicArtifactRoutes(app, {
    db,
    downloadTokenTtlSeconds: config.downloadTokenTtlSeconds,
    artifactEncryptionKey: config.artifactEncryptionKey,
    requireUser: auth.requireUser
  });
  registerAdminGatesRoutes(app, { db, requireAdmin: auth.requireAdmin });
  registerGateAgentDeploymentRoutes(app, {
    db,
    releaseDir: config.gateAgentReleaseDir,
    requireAdmin: auth.requireAdmin,
    requireGate: auth.requireGate
  });
  registerAdminSessionRoutes(app, { db, requireAdmin: auth.requireAdmin });
  registerAdminJobRoutes(app, { db, requireAdmin: auth.requireAdmin });
  registerAdminAuditRoutes(app, { db, requireAdmin: auth.requireAdmin });
  registerAdminBillingRoutes(app, {
    db,
    requireAdmin: auth.requireBillingAdmin,
    billing: config.billing,
    treasury: solanaRpcUrl && treasuryAddress
      ? {
        address: treasuryAddress,
        readBalance: () => readSolanaNativeBalance(
          treasuryAddress,
          { rpcUrl: solanaRpcUrl }
        )
      }
      : null
  });
  registerAdminTradingProbeRoutes(app, { db, requireAdmin: auth.requireAdmin });
  registerAgentSessionRoutes(app);
  registerAgentEntitlementRoutes(app);
  registerGateActualStateRoutes(app, { db, requireGate: auth.requireGate });
  registerGateHeartbeatRoutes(app, { db, requireGate: auth.requireGate });
  registerGateJobRoutes(app, { db, requireGate: auth.requireGate });
  registerTradingProbeAgentRoutes(app, {
    db,
    requireTradingProbe: auth.requireTradingProbe
  });
  registerMetricsRoute(app, metrics);
  health.setComponent("process", { state: "ready", message: "Fastify app is ready." });

  return app;
}

export function serializeRequestForLog(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: requestPathForLog(request.url),
    host: request.hostname,
    remoteAddress: request.ip,
    peerAddress: request.raw.socket.remoteAddress,
    remotePort: request.raw.socket.remotePort
  };
}

export function requestPathForLog(url: string | undefined): string {
  return (url?.split("?", 1)[0] || "/").replace(/(\/artifacts\/download\/)[^/]+/, "$1[redacted]");
}

function registerRuntimeMetricsHooks(app: FastifyInstance, metrics: RuntimeMetrics): void {
  const startedAt = new WeakMap<object, bigint>();
  app.addHook("onRequest", async (request) => {
    startedAt.set(request, process.hrtime.bigint());
  });
  app.addHook("onSend", async (request, reply, payload) => {
    const start = startedAt.get(request);
    if (start) {
      const stages = reply.getHeader("Server-Timing");
      reply.header("Server-Timing", `${stages ? `${stages}, ` : ""}app;dur=${(Number(process.hrtime.bigint() - start) / 1_000_000).toFixed(2)}`);
    }
    return payload;
  });
  app.addHook("onResponse", async (request, reply) => {
    const start = startedAt.get(request);
    const durationSeconds = start ? Number(process.hrtime.bigint() - start) / 1_000_000_000 : 0;
    const route = request.routeOptions.url ?? "unmatched";
    if (!request.url.startsWith("/v1/public/auth/")) {
      request.log.info({ req: request, status: reply.statusCode, responseTime: durationSeconds * 1000,
        serverTiming: reply.getHeader("Server-Timing") }, "request completed");
    }
    const labels = {
      method: request.method,
      route,
      status: String(reply.statusCode)
    };
    metrics.counter("api_http_requests_total", 1, {
      help: "Total API HTTP requests by route and status.",
      labels
    });
    metrics.histogram("api_http_request_duration_seconds", durationSeconds, {
      help: "API HTTP request duration in seconds.",
      buckets: [0.005, 0.01, 0.025, 0.03, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      labels: {
        method: request.method,
        route
      }
    });
  });
}

function registerMetricsRoute(app: FastifyInstance, metrics: RuntimeMetrics): void {
  app.get("/metrics", {
    schema: {
      response: {
        200: { type: "string" }
      }
    }
  }, async (_request, reply) => reply
    .type("text/plain; version=0.0.4; charset=utf-8")
    .send(metrics.renderPrometheus()));
}
