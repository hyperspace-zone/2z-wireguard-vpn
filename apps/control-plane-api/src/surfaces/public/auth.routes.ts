import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  errorResponseSchema,
  publicAuthMeResponseSchema,
  publicAuthResponseSchema,
  publicCreateSolanaWalletChallengeRequestSchema,
  publicGoogleOAuthStartResponseSchema,
  publicLinkSolanaWalletRequestSchema,
  publicLinkSolanaWalletResponseSchema,
  publicLoginRequestSchema,
  publicRegisterRequestSchema,
  publicRequestEmailLoginCodeRequestSchema,
  publicRequestEmailLoginCodeResponseSchema,
  publicSolanaWalletChallengeResponseSchema,
  publicVerifyEmailLoginCodeRequestSchema,
  publicWalletLinksResponseSchema
} from "@hyperspace-zone/contracts";
import {
  completeGoogleOAuth,
  createGoogleOAuthStart,
  createSolanaWalletChallenge,
  linkSolanaWallet,
  listSolanaWalletLinks,
  loginUser,
  registerUser,
  requestEmailLoginCode,
  verifyEmailLoginCode,
  type EmailSender,
  type GoogleOAuthConfig
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { PublicAuthUser } from "../../http/auth.js";
import { sendApplicationError, type ApplicationErrorCode } from "../../http/errors.js";
import { asRecord, readQuery, readString } from "../../http/request.js";

export function registerPublicAuthRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
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
    walletAuth: {
      challengeHashSecret: string;
      challengeTtlSeconds: number;
    };
    requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<PublicAuthUser | null>;
  }
): void {
  const emailSender = createEmailSender(deps.emailAuth);

  app.post("/v1/public/auth/register", {
    schema: {
      body: publicRegisterRequestSchema,
      response: {
        201: publicRequestEmailLoginCodeResponseSchema,
        400: errorResponseSchema,
        409: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const body = asRecord(request.body);
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

    const challenge = await requestEmailLoginCode(deps.db, {
      email: result.email,
      codeTtlSeconds: deps.emailAuth.otpTtlSeconds,
      hashSecret: deps.emailAuth.otpHashSecret,
      sender: emailSender,
      exposeCode: deps.emailAuth.exposeCodes
    });
    if (challenge === "invalid_email") {
      return sendApplicationError(reply, "invalid_email");
    }
    return reply.code(201).send(challenge);
  });

  app.post("/v1/public/auth/login", {
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
    schema: {
      body: publicRequestEmailLoginCodeRequestSchema,
      response: {
        200: publicRequestEmailLoginCodeResponseSchema,
        400: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const body = asRecord(request.body);
    const result = await requestEmailLoginCode(deps.db, {
      email: readString(body, "email"),
      codeTtlSeconds: deps.emailAuth.otpTtlSeconds,
      hashSecret: deps.emailAuth.otpHashSecret,
      sender: emailSender,
      exposeCode: deps.emailAuth.exposeCodes
    });
    if (result === "invalid_email") {
      return sendApplicationError(reply, "invalid_email");
    }
    return reply.send(result);
  });

  app.post("/v1/public/auth/email/verify-code", {
    schema: {
      body: publicVerifyEmailLoginCodeRequestSchema,
      response: {
        200: publicAuthResponseSchema,
        400: errorResponseSchema
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
    return reply.send({ user });
  });

  app.get("/v1/public/auth/wallets", {
    schema: {
      response: {
        200: publicWalletLinksResponseSchema,
        401: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const user = await deps.requireUser(request, reply);
    if (!user) {
      return;
    }
    return reply.send({ wallets: await listSolanaWalletLinks(deps.db, user.accountId) });
  });

  app.post("/v1/public/auth/wallets/solana/challenge", {
    schema: {
      body: publicCreateSolanaWalletChallengeRequestSchema,
      response: {
        200: publicSolanaWalletChallengeResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const user = await deps.requireUser(request, reply);
    if (!user) {
      return;
    }
    const body = asRecord(request.body);
    const result = await createSolanaWalletChallenge(deps.db, user, {
      publicKey: readString(body, "publicKey"),
      nonceHashSecret: deps.walletAuth.challengeHashSecret,
      challengeTtlSeconds: deps.walletAuth.challengeTtlSeconds
    });
    if (result === "invalid_public_key") {
      return sendApplicationError(reply, "invalid_wallet_public_key");
    }
    return reply.send(result);
  });

  app.post("/v1/public/auth/wallets/solana/link", {
    schema: {
      body: publicLinkSolanaWalletRequestSchema,
      response: {
        200: publicLinkSolanaWalletResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const user = await deps.requireUser(request, reply);
    if (!user) {
      return;
    }
    const body = asRecord(request.body);
    const result = await linkSolanaWallet(deps.db, user, {
      publicKey: readString(body, "publicKey"),
      nonce: readString(body, "nonce"),
      signature: readString(body, "signature"),
      nonceHashSecret: deps.walletAuth.challengeHashSecret
    });
    if (typeof result === "string") {
      return sendApplicationError(reply, walletLinkError(result));
    }
    return reply.send({ wallet: result.wallet });
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

function walletLinkError(error: string): ApplicationErrorCode {
  switch (error) {
    case "invalid_public_key":
      return "invalid_wallet_public_key";
    case "challenge_not_found":
    case "challenge_expired":
      return "invalid_wallet_challenge";
    default:
      return "invalid_wallet_signature";
  }
}

function createEmailSender(config: {
  provider: "console" | "resend";
  resendApiKey: string;
  from: string;
  replyTo: string;
}): EmailSender {
  if (config.provider === "resend" && config.resendApiKey) {
    return new ResendEmailSender(config);
  }
  return {
    async sendLoginCode(input) {
      console.log(JSON.stringify({ event: "email_login_code", email: input.email, code: input.code, expiresAt: input.expiresAt }));
    }
  };
}

class ResendEmailSender implements EmailSender {
  constructor(private readonly config: {
    resendApiKey: string;
    from: string;
    replyTo: string;
  }) {}

  async sendLoginCode(input: { email: string; code: string; expiresAt: string }): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.resendApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: this.config.from,
        to: [input.email],
        reply_to: this.config.replyTo,
        subject: "Your Hyperspace sign-in code",
        text: [
          `Your Hyperspace sign-in code is ${input.code}.`,
          "",
          `It expires at ${input.expiresAt}.`,
          "",
          "If you did not request this code, you can ignore this email."
        ].join("\n")
      })
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`resend_delivery_failed:${response.status}:${body.slice(0, 200)}`);
    }
  }
}
