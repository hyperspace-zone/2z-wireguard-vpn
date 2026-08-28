import type { FastifyReply, FastifyRequest } from "fastify";
import {
  authenticateGateToken,
  authenticateTradingProbeToken,
  authenticatePublicAuthSession,
  userHasRole,
  type AuthenticatedGate,
  type AuthenticatedTradingProbeNode,
  type Principal,
  type PublicUser
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import { sendApplicationError } from "./errors.js";
import { bearerToken, headerValue } from "./request.js";

export type PublicAuthUser = PublicUser;

export type GateAuthContext = AuthenticatedGate;
export type TradingProbeAuthContext = AuthenticatedTradingProbeNode;

export interface AdminAuthContext extends Principal {
  kind: "admin";
}

export interface HttpAuth {
  requireUser(request: FastifyRequest, reply: FastifyReply): Promise<PublicAuthUser | null>;
  requireGate(request: FastifyRequest, reply: FastifyReply): Promise<GateAuthContext | null>;
  requireTradingProbe(request: FastifyRequest, reply: FastifyReply): Promise<TradingProbeAuthContext | null>;
  requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<AdminAuthContext | null>;
  requireBillingAdmin(request: FastifyRequest, reply: FastifyReply): Promise<AdminAuthContext | null>;
  hasBillingAdminAccess(user: PublicAuthUser): Promise<boolean>;
}

export const operatorTokenAdminId = "00000000-0000-4000-8000-000000000001";

export function createHttpAuth(input: {
  db: Database;
  adminToken: string | undefined;
  billingAdminEmails?: string[];
}): HttpAuth {
  const configuredBillingAdminEmails = new Set(
    (input.billingAdminEmails ?? []).map((email) => email.trim().toLowerCase()).filter(Boolean)
  );

  async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<PublicAuthUser | null> {
    const token = bearerToken(request);
    if (!token) {
      sendApplicationError(reply, "auth_required");
      return null;
    }

    const user = await authenticatePublicAuthSession(input.db, token);
    if (!user) {
      sendApplicationError(reply, "invalid_auth_session");
      return null;
    }

    return user;
  }

  async function requireGate(request: FastifyRequest, reply: FastifyReply): Promise<GateAuthContext | null> {
    const gateName = headerValue(request, "x-gate-name");
    const gateToken = headerValue(request, "x-gate-token");
    if (!gateName || !gateToken) {
      sendApplicationError(reply, "gate_auth_required");
      return null;
    }

    const gate = await authenticateGateToken(input.db, { gateName, gateToken });
    if (!gate) {
      sendApplicationError(reply, "invalid_gate_credentials");
      return null;
    }
    return gate;
  }

  async function requireTradingProbe(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<TradingProbeAuthContext | null> {
    const nodeName = headerValue(request, "x-probe-node-name");
    const nodeToken = headerValue(request, "x-probe-node-token");
    if (!nodeName || !nodeToken) {
      sendApplicationError(reply, "trading_probe_auth_required");
      return null;
    }
    const node = await authenticateTradingProbeToken(input.db, { nodeName, nodeToken });
    if (!node) {
      sendApplicationError(reply, "invalid_trading_probe_credentials");
      return null;
    }
    return node;
  }

  async function requireRole(
    request: FastifyRequest,
    reply: FastifyReply,
    allowedRoles: string[]
  ): Promise<AdminAuthContext | null> {
    if (input.adminToken && headerValue(request, "x-admin-token") === input.adminToken) {
      return { kind: "admin", id: operatorTokenAdminId };
    }
    const token = bearerToken(request);
    const user = token ? await authenticatePublicAuthSession(input.db, token) : null;
    if (user && (await Promise.all(allowedRoles.map((role) => userHasRole(input.db, user.id, role)))).some(Boolean)) {
      return { kind: "admin", id: user.id, accountId: user.accountId };
    }
    sendApplicationError(reply, input.adminToken || user ? "admin_auth_required" : "admin_surface_not_configured");
    return null;
  }

  async function hasBillingAdminAccess(user: PublicAuthUser): Promise<boolean> {
    const [billingAdmin, platformAdmin] = await Promise.all([
      userHasRole(input.db, user.id, "billing_admin"),
      userHasRole(input.db, user.id, "platform_admin")
    ]);
    if (billingAdmin || platformAdmin) {
      return true;
    }
    if (!configuredBillingAdminEmails.has(user.email.trim().toLowerCase())) {
      return false;
    }
    const verified = await input.db.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM identities
         WHERE identities.account_id = $1
           AND lower(identities.email::text) = lower($2)
           AND identities.verified_at IS NOT NULL
       ) AS allowed`,
      [user.accountId, user.email]
    );
    return verified.rows[0]?.allowed === true;
  }

  const requireAdmin = (request: FastifyRequest, reply: FastifyReply) =>
    requireRole(request, reply, ["platform_admin"]);

  async function requireBillingAdmin(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<AdminAuthContext | null> {
    if (input.adminToken && headerValue(request, "x-admin-token") === input.adminToken) {
      return { kind: "admin", id: operatorTokenAdminId };
    }
    const token = bearerToken(request);
    const user = token ? await authenticatePublicAuthSession(input.db, token) : null;
    if (user && await hasBillingAdminAccess(user)) {
      return { kind: "admin", id: user.id, accountId: user.accountId };
    }
    sendApplicationError(reply, input.adminToken || user ? "admin_auth_required" : "admin_surface_not_configured");
    return null;
  }

  return {
    requireUser,
    requireGate,
    requireTradingProbe,
    requireAdmin,
    requireBillingAdmin,
    hasBillingAdminAccess
  };
}
