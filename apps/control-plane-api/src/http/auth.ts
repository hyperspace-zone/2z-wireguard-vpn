import type { FastifyReply, FastifyRequest } from "fastify";
import {
  authenticateGateToken,
  authenticatePublicAuthSession,
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
  requireAdmin(request: FastifyRequest, reply: FastifyReply): AdminAuthContext | null;
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

  function requireAdmin(request: FastifyRequest, reply: FastifyReply): AdminAuthContext | null {
    if (!input.adminToken) {
      sendApplicationError(reply, "admin_surface_not_configured");
      return null;
    }
    if (headerValue(request, "x-admin-token") !== input.adminToken) {
      sendApplicationError(reply, "admin_auth_required");
      return null;
    }
    return { kind: "admin", id: "admin" };
  }

  return { requireUser, requireGate, requireAdmin };
}
