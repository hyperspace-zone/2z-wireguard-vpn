import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "@hyperspace-zone/db";
import { registerAbuseControls, type AbuseControlsConfig } from "./http/abuse-controls.js";
import { createHttpAuth } from "./http/auth.js";
import { registerOpenApiRoute } from "./http/openapi.js";
import { registerAdminAuditRoutes } from "./surfaces/admin/audit.routes.js";
import { registerAdminGatesRoutes } from "./surfaces/admin/gates.routes.js";
import { registerAdminJobRoutes } from "./surfaces/admin/jobs.routes.js";
import { registerAdminSessionRoutes } from "./surfaces/admin/sessions.routes.js";
import { registerAgentEntitlementRoutes } from "./surfaces/agent/entitlements.routes.js";
import { registerAgentSessionRoutes } from "./surfaces/agent/sessions.routes.js";
import { registerGateActualStateRoutes } from "./surfaces/gate/actual-state.routes.js";
import { registerGateHeartbeatRoutes } from "./surfaces/gate/heartbeat.routes.js";
import { registerGateJobRoutes } from "./surfaces/gate/jobs.routes.js";
import { registerHealthRoutes } from "./surfaces/health.routes.js";
import { registerPublicArtifactRoutes } from "./surfaces/public/artifacts.routes.js";
import { registerPublicAuthRoutes } from "./surfaces/public/auth.routes.js";
import { registerPublicGatesRoutes } from "./surfaces/public/gates.routes.js";
import { registerPublicNetworkRoutes } from "./surfaces/public/network.routes.js";
import { registerPublicSessionsRoutes } from "./surfaces/public/sessions.routes.js";

export interface ControlPlaneApiRuntimeConfig {
  authSessionTtlSeconds: number;
  downloadTokenTtlSeconds: number;
  adminToken?: string;
  artifactEncryptionKey: Buffer | null;
  abuseControls: AbuseControlsConfig;
}

export interface CreateControlPlaneApiAppInput {
  db: Database;
  config: ControlPlaneApiRuntimeConfig;
}

export function createApp(input: CreateControlPlaneApiAppInput): FastifyInstance {
  const { db, config } = input;
  const auth = createHttpAuth({ db, adminToken: config.adminToken });

  const app = Fastify({
    logger: true
  });

  registerAbuseControls(app, config.abuseControls);
  registerOpenApiRoute(app);
  registerHealthRoutes(app);
  registerPublicAuthRoutes(app, {
    db,
    authSessionTtlSeconds: config.authSessionTtlSeconds,
    requireUser: auth.requireUser
  });
  registerPublicGatesRoutes(app, { db });
  registerPublicNetworkRoutes(app, { requireUser: auth.requireUser });
  registerPublicSessionsRoutes(app, { db, requireUser: auth.requireUser });
  registerPublicArtifactRoutes(app, {
    db,
    downloadTokenTtlSeconds: config.downloadTokenTtlSeconds,
    artifactEncryptionKey: config.artifactEncryptionKey,
    requireUser: auth.requireUser
  });
  registerAdminGatesRoutes(app, { db, requireAdmin: auth.requireAdmin });
  registerAdminSessionRoutes(app, { db, requireAdmin: auth.requireAdmin });
  registerAdminJobRoutes(app, { db, requireAdmin: auth.requireAdmin });
  registerAdminAuditRoutes(app, { db, requireAdmin: auth.requireAdmin });
  registerAgentSessionRoutes(app);
  registerAgentEntitlementRoutes(app);
  registerGateActualStateRoutes(app, { db, requireGate: auth.requireGate });
  registerGateHeartbeatRoutes(app, { db, requireGate: auth.requireGate });
  registerGateJobRoutes(app, { db, requireGate: auth.requireGate });

  return app;
}
