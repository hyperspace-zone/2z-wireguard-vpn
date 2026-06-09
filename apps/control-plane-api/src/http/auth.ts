import type { FastifyReply, FastifyRequest } from "fastify";
import { authenticateGateToken, type AuthenticatedGate, type Principal } from "@hyperspace-zone/control-plane";
import { sha256Hex, type Database } from "@hyperspace-zone/db";
import { bearerToken, headerValue } from "./request.js";

export interface PublicAuthUser {
  id: string;
  accountId: string;
  email: string;
  displayName: string;
}

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
      reply.code(401).send({ error: "auth_required" });
      return null;
    }

    const tokenHash = sha256Hex(token);
    const result = await input.db.query<PublicAuthUser>(
      `
        SELECT
          users.id,
          users.account_id AS "accountId",
          users.email::text,
          users.display_name AS "displayName"
        FROM auth_sessions
        JOIN users ON users.id = auth_sessions.user_id
        WHERE auth_sessions.token_hash = $1
          AND auth_sessions.expires_at > now()
          AND auth_sessions.revoked_at IS NULL
          AND users.disabled_at IS NULL
      `,
      [tokenHash]
    );
    const user = result.rows[0] ?? null;
    if (!user) {
      reply.code(401).send({ error: "invalid_auth_session" });
      return null;
    }

    await input.db.query("UPDATE auth_sessions SET last_seen_at = now() WHERE token_hash = $1", [tokenHash]);
    return user;
  }

  async function requireGate(request: FastifyRequest, reply: FastifyReply): Promise<GateAuthContext | null> {
    const gateName = headerValue(request, "x-gate-name");
    const gateToken = headerValue(request, "x-gate-token");
    if (!gateName || !gateToken) {
      reply.code(401).send({ error: "gate_auth_required" });
      return null;
    }

    const gate = await authenticateGateToken(input.db, { gateName, gateToken });
    if (!gate) {
      reply.code(401).send({ error: "invalid_gate_credentials" });
      return null;
    }
    return gate;
  }

  function requireAdmin(request: FastifyRequest, reply: FastifyReply): AdminAuthContext | null {
    if (!input.adminToken) {
      reply.code(503).send({ error: "admin_surface_not_configured" });
      return null;
    }
    if (headerValue(request, "x-admin-token") !== input.adminToken) {
      reply.code(401).send({ error: "admin_auth_required" });
      return null;
    }
    return { kind: "admin", id: "admin" };
  }

  return { requireUser, requireGate, requireAdmin };
}
