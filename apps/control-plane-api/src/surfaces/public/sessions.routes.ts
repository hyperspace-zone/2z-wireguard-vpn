import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  errorResponseSchema,
  publicCreateSessionRequestSchema,
  publicSessionResponseSchema,
  publicSessionsResponseSchema
} from "@hyperspace-zone/contracts";
import {
  createSession,
  deleteHiddenSession,
  listPublicSessions,
  parseSessionCreateBody,
  readOwnSession,
  revokeSession
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { PublicAuthUser } from "../../http/auth.js";
import { asRecord, readParam } from "../../http/request.js";

export function registerPublicSessionsRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<PublicAuthUser | null>;
  }
): void {
  app.get("/v1/public/sessions", {
    schema: {
      response: {
        200: publicSessionsResponseSchema
      }
    }
  }, async (request, reply) => {
    const user = await deps.requireUser(request, reply);
    if (!user) {
      return;
    }

    return reply.send({ sessions: await listPublicSessions(deps.db, user.accountId) });
  });

  app.post("/v1/public/sessions", {
    schema: {
      body: publicCreateSessionRequestSchema,
      response: {
        201: publicSessionResponseSchema,
        400: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const user = await deps.requireUser(request, reply);
    if (!user) {
      return;
    }

    const parsed = parseSessionCreateBody(asRecord(request.body));
    if ("error" in parsed) {
      return reply.code(400).send(parsed);
    }

    const created = await createSession(deps.db, user, parsed);
    const session = await readOwnSession(deps.db, user.accountId, created);
    return reply.code(201).send({ session });
  });

  app.get("/v1/public/sessions/:sessionId", {
    schema: {
      response: {
        200: publicSessionResponseSchema,
        404: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const user = await deps.requireUser(request, reply);
    if (!user) {
      return;
    }

    const sessionId = readParam(request, "sessionId");
    const session = await readOwnSession(deps.db, user.accountId, sessionId);
    if (!session) {
      return reply.code(404).send({ error: "session_not_found" });
    }

    return reply.send({ session });
  });

  app.post("/v1/public/sessions/:sessionId/revoke", {
    schema: {
      response: {
        200: publicSessionResponseSchema,
        404: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const user = await deps.requireUser(request, reply);
    if (!user) {
      return;
    }

    const sessionId = readParam(request, "sessionId");
    const result = await revokeSession(deps.db, user, sessionId);
    if (result === "not_found") {
      return reply.code(404).send({ error: "session_not_found" });
    }

    return reply.send({ session: await readOwnSession(deps.db, user.accountId, sessionId) });
  });

  app.delete("/v1/public/sessions/:sessionId", {
    schema: {
      response: {
        204: { type: "null" },
        404: errorResponseSchema,
        409: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const user = await deps.requireUser(request, reply);
    if (!user) {
      return;
    }

    const sessionId = readParam(request, "sessionId");
    const result = await deleteHiddenSession(deps.db, user, sessionId);
    if (result === "not_found") {
      return reply.code(404).send({ error: "session_not_found" });
    }
    if (result === "not_revoked") {
      return reply.code(409).send({ error: "session_not_revoked" });
    }
    return reply.code(204).send();
  });
}
