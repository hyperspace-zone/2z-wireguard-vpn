import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  errorResponseSchema,
  publicAuthMeResponseSchema,
  publicAuthResponseSchema,
  publicAuthSecurityResponseSchema,
  publicGoogleOAuthStartResponseSchema,
  publicLoginRequestSchema,
  publicRegisterRequestSchema,
  publicRequestEmailLoginCodeRequestSchema,
  publicRequestEmailLoginCodeResponseSchema,
  publicVerifyEmailLoginCodeRequestSchema
} from "@hyperspace-zone/contracts";
import {
  completeGoogleOAuth,
  createGoogleOAuthStart,
  loginUser,
  registerUser,
  requestEmailLoginCode,
  verifyEmailLoginCode,
  pauseEmailSending,
  type GoogleOAuthConfig
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { RuntimeMetrics } from "@hyperspace-zone/shared";
import type { PublicAuthUser } from "../../http/auth.js";
import { sendApplicationError, type ApplicationErrorCode } from "../../http/errors.js";
import { asRecord, clientIpForSecurity, readQuery, readString } from "../../http/request.js";
import { setAuthOutcome } from "../../http/auth-audit.js";
import { createEmailAuthProtection, type EmailAuthProtectionConfig } from "../../services/email-auth-protection.js";
import { createEmailSender, EmailDeliveryError } from "../../services/email-sender.js";

export function registerPublicAuthRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    protection: EmailAuthProtectionConfig;
    metrics?: RuntimeMetrics;
    authSessionTtlSeconds: number;
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
    requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<PublicAuthUser | null>;
    hasBillingAdminAccess: (user: PublicAuthUser) => Promise<boolean>;
  }
): void {
  const emailSender = createEmailSender(deps.emailAuth, deps.metrics);
  const protection = createEmailAuthProtection(app, deps.db, deps.protection, deps.emailAuth.otpHashSecret, deps.metrics);
  app.get("/v1/public/auth/security", { schema: { response: { 200: publicAuthSecurityResponseSchema } } }, async (_request, reply) => reply.header("cache-control", "no-store").send({
    turnstileEnabled: deps.protection.turnstile.enabled,
    turnstileSiteKey: deps.protection.turnstile.enabled ? deps.protection.turnstile.siteKey : ""
  }));

  async function sendCode(request: FastifyRequest, reply: FastifyReply, email: string, status = 200): Promise<FastifyReply> {
    try {
      const result = await requestEmailLoginCode(deps.db, {
        email, codeTtlSeconds: deps.emailAuth.otpTtlSeconds, hashSecret: deps.emailAuth.otpHashSecret,
        sender: emailSender, exposeCode: deps.emailAuth.exposeCodes,
        requestInfo: { sourceIp: clientIpForSecurity(request), requestId: request.id, turnstileVerified: deps.protection.turnstile.enabled }
      });
      if (typeof result === "string") { setAuthOutcome(request, result); return sendApplicationError(reply, result); }
      setAuthOutcome(request, "code_sent");
      return reply.code(status).send(result);
    } catch (error) {
      const failure = error instanceof EmailDeliveryError ? error : new EmailDeliveryError("provider_unavailable", 30);
      await pauseEmailSending(deps.db, failure.retryAfter).catch(() => { app.log.warn({ event: "email_backoff_persist_failed" }); });
      setAuthOutcome(request, failure.reason);
      return reply.code(503).header("retry-after", String(failure.retryAfter)).header("cache-control", "no-store")
        .send({ error: "email_delivery_unavailable", message: "Could not send email. Try again later or use Google." });
    }
  }

  app.post("/v1/public/auth/register", {
    bodyLimit: 16_384,
    schema: {
      body: publicRegisterRequestSchema,
      response: {
        201: publicRequestEmailLoginCodeResponseSchema,
        400: errorResponseSchema,
        409: errorResponseSchema,
        403: errorResponseSchema,
        429: errorResponseSchema,
        503: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!await protection.admit(request, reply, "register")) return;
    const result = await registerUser(deps.db, {
      email: readString(body, "email"),
      password: readString(body, "password"),
      displayName: readString(body, "displayName")
    });
    if (result === "invalid_email") {
      return sendApplicationError(reply, "invalid_email");
    }
    if (result === "weak_password") {
      return sendApplicationError(reply, "weak_password", { message: "password must be at least 12 characters" });
    }
    if (result === "email_already_registered") {
      return sendApplicationError(reply, result);
    }

    return sendCode(request, reply, result.email, 201);
  });

  app.post("/v1/public/auth/login", {
    bodyLimit: 16_384,
    schema: {
      body: publicLoginRequestSchema,
      response: {
        200: publicAuthResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const body = asRecord(request.body);
    const result = await loginUser(deps.db, {
      email: readString(body, "email"),
      password: readString(body, "password"),
      authSessionTtlSeconds: deps.authSessionTtlSeconds
    });
    if (result === "credentials_required") {
      return sendApplicationError(reply, "credentials_required");
    }
    if (result === "invalid_credentials") {
      return sendApplicationError(reply, "invalid_credentials");
    }
    if (result === "email_not_verified") {
      return sendApplicationError(reply, "email_not_verified");
    }

    return reply.send(result);
  });

  app.post("/v1/public/auth/email/request-code", {
    bodyLimit: 16_384,
    schema: {
      body: publicRequestEmailLoginCodeRequestSchema,
      response: {
        200: publicRequestEmailLoginCodeResponseSchema,
        400: errorResponseSchema,
        403: errorResponseSchema,
        429: errorResponseSchema,
        503: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const body = asRecord(request.body);
    if (!await protection.admit(request, reply, "email_otp")) return;
    return sendCode(request, reply, readString(body, "email"));
  });

  app.post("/v1/public/auth/email/verify-code", {
    bodyLimit: 16_384,
    schema: {
      body: publicVerifyEmailLoginCodeRequestSchema,
      response: {
        200: publicAuthResponseSchema,
        400: errorResponseSchema,
        429: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const body = asRecord(request.body);
    const result = await verifyEmailLoginCode(deps.db, {
      email: readString(body, "email"),
      code: readString(body, "code"),
      hashSecret: deps.emailAuth.otpHashSecret,
      authSessionTtlSeconds: deps.authSessionTtlSeconds
    });
    if (typeof result === "string") {
      setAuthOutcome(request, result);
      return sendApplicationError(reply, emailCodeError(result));
    }
    return reply.send(result);
  });

  app.get("/v1/public/auth/google/start", {
    schema: {
      response: {
        200: publicGoogleOAuthStartResponseSchema,
        503: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    if (!deps.googleOAuth) {
      return sendApplicationError(reply, "oauth_not_configured");
    }
    const result = await createGoogleOAuthStart(deps.db, deps.googleOAuth, {
      redirectAfter: readQuery(request, "redirect")
    });
    return reply.send(result);
  });

  app.get("/v1/public/auth/google/callback", {
    schema: {
      response: {
        302: { type: "null" },
        400: errorResponseSchema,
        403: errorResponseSchema,
        503: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    if (!deps.googleOAuth) {
      return sendApplicationError(reply, "oauth_not_configured");
    }
    const code = readQuery(request, "code");
    const state = readQuery(request, "state");
    const result = await completeGoogleOAuth(deps.db, deps.googleOAuth, { code, state });
    if (typeof result === "string") {
      return sendApplicationError(reply, googleOAuthError(result));
    }

    const redirect = new URL(result.redirectAfter, deps.googleOAuth.appRedirectUrl);
    redirect.hash = `access_token=${encodeURIComponent(result.auth.accessToken)}&expires_at=${encodeURIComponent(result.auth.expiresAt)}`;
    return reply.redirect(redirect.toString(), 302);
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
    const billingAdmin = await deps.hasBillingAdminAccess(user);
    return reply.send({
      user,
      capabilities: billingAdmin ? ["billing:admin"] : []
    });
  });

}

function emailCodeError(error: string): ApplicationErrorCode {
  switch (error) {
    case "code_expired":
      return "email_code_expired";
    case "too_many_attempts":
      return "too_many_attempts";
    case "invalid_email":
      return "invalid_email";
    default:
      return "invalid_email_code";
  }
}

function googleOAuthError(error: string): ApplicationErrorCode {
  switch (error) {
    case "oauth_state_invalid":
    case "oauth_state_expired":
      return "invalid_oauth_state";
    case "oauth_email_not_verified":
      return "oauth_email_not_verified";
    default:
      return "oauth_exchange_failed";
  }
}
