import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  errorResponseSchema,
  publicAuthMeResponseSchema,
  publicAuthResponseSchema,
  publicLoginRequestSchema,
  publicRegisterRequestSchema
} from "@hyperspace-zone/contracts";
import { loginUser, registerUser } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { PublicAuthUser } from "../../http/auth.js";
import { sendApplicationError } from "../../http/errors.js";
import { asRecord, readString } from "../../http/request.js";

export function registerPublicAuthRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authSessionTtlSeconds: number;
    requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<PublicAuthUser | null>;
  }
): void {
  app.post("/v1/public/auth/register", {
    schema: {
      body: publicRegisterRequestSchema,
      response: {
        201: publicAuthResponseSchema,
        400: errorResponseSchema,
        409: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const body = asRecord(request.body);
    const email = normalizeEmail(readString(body, "email"));
    const password = readString(body, "password");
    const displayName = readString(body, "displayName") || email;

    if (!email || !email.includes("@")) {
      return sendApplicationError(reply, "invalid_email");
    }
    if (!password || password.length < 12) {
      return sendApplicationError(reply, "weak_password", { message: "password must be at least 12 characters" });
    }

    const result = await registerUser(deps.db, {
      email,
      password,
      displayName,
      authSessionTtlSeconds: deps.authSessionTtlSeconds
    });
    if (result === "email_already_registered") {
      return sendApplicationError(reply, result);
    }

    return reply.code(201).send(result);
  });

  app.post("/v1/public/auth/login", {
    schema: {
      body: publicLoginRequestSchema,
      response: {
        200: publicAuthResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const body = asRecord(request.body);
    const email = normalizeEmail(readString(body, "email"));
    const password = readString(body, "password");

    if (!email || !password) {
      return sendApplicationError(reply, "credentials_required");
    }

    const result = await loginUser(deps.db, {
      email,
      password,
      authSessionTtlSeconds: deps.authSessionTtlSeconds
    });
    if (result === "invalid_credentials") {
      return sendApplicationError(reply, "invalid_credentials");
    }

    return reply.send(result);
  });

  app.get("/v1/public/auth/me", {
    schema: {
      response: {
        200: publicAuthMeResponseSchema,
        401: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const user = await deps.requireUser(request, reply);
    if (!user) {
      return;
    }
    return reply.send({ user });
  });
}

function normalizeEmail(value: string): string {
  return value.toLowerCase();
}
