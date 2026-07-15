import type { FastifyReply, FastifyRequest } from "fastify";
import {
  authenticateGateToken,
  authenticatePublicAuthSession,
  userHasRole,
  type AuthenticatedGate,
  type Principal,
  type PublicUser
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import { sendApplicationError } from "./errors.js";
import { bearerToken, headerValue } from "./request.js";

export type PublicAuthUser = PublicUser;

export type GateAuthContext = AuthenticatedGate;

export interface AdminAuthContext extends Principal {
  kind: "admin";
}

export interface HttpAuth {
  requireUser(request: FastifyRequest, reply: FastifyReply): Promise<PublicAuthUser | null>;
  requireGate(request: FastifyRequest, reply: FastifyReply): Promise<GateAuthContext | null>;
  requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<AdminAuthContext | null>;
  requireBillingAdmin(request: FastifyRequest, reply: FastifyReply): Promise<AdminAuthContext | null>;
}

export function createHttpAuth(input: { db: Database; adminToken: string | undefined }): HttpAuth {
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

  async function requireRole(
    request: FastifyRequest,
    reply: FastifyReply,
    allowedRoles: string[]
  ): Promise<AdminAuthContext | null> {
    if (input.adminToken && headerValue(request, "x-admin-token") === input.adminToken) {
      return { kind: "admin", id: "operator-token" };
    }
    const token = bearerToken(request);
    const user = token ? await authenticatePublicAuthSession(input.db, token) : null;
    if (user && (await Promise.all(allowedRoles.map((role) => userHasRole(input.db, user.id, role)))).some(Boolean)) {
      return { kind: "admin", id: user.id, accountId: user.accountId };
    }
    sendApplicationError(reply, input.adminToken || user ? "admin_auth_required" : "admin_surface_not_configured");
    return null;
  }

  const requireAdmin = (request: FastifyRequest, reply: FastifyReply) =>
    requireRole(request, reply, ["platform_admin"]);
  const requireBillingAdmin = (request: FastifyRequest, reply: FastifyReply) =>
    requireRole(request, reply, ["billing_admin", "platform_admin"]);

  return { requireUser, requireGate, requireAdmin, requireBillingAdmin };
}
