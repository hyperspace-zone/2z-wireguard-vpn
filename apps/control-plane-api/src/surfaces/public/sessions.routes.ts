import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  errorResponseSchema,
  publicCreateSessionRequestSchema,
  publicSessionResponseSchema,
  publicSessionsResponseSchema
} from "@hyperspace-zone/contracts";
import {
  accountHasSufficientBalance,
  activatePaidSession,
  createSession,
  deleteUnpaidSession,
  deleteHiddenSession,
  listPublicSessions,
  readOwnSession,
  revokeSession,
  type SessionAbuseControlConfig
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { PublicAuthUser } from "../../http/auth.js";
import { sendApplicationError, type ApplicationErrorCode } from "../../http/errors.js";
import { asRecord, readParam, readString } from "../../http/request.js";
import type { SolanaConfigPaymentService } from "../../services/solana-config-payment.js";

export function registerPublicSessionsRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<PublicAuthUser | null>;
    billing: {
      enforcePositiveBalance: boolean;
      requiredMinBalanceMinor: number;
      configPaymentEnabled?: boolean;
    };
    configPaymentService: SolanaConfigPaymentService | null;
    selfServiceAbuseControls: SessionAbuseControlConfig;
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
        400: errorResponseSchema,
        402: errorResponseSchema,
        403: errorResponseSchema,
        409: errorResponseSchema,
        429: errorResponseSchema,
        503: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const user = await deps.requireUser(request, reply);
    if (!user) {
      return;
    }

    if (deps.billing.enforcePositiveBalance) {
      const hasBalance = await accountHasSufficientBalance(
        deps.db,
        user.accountId,
        deps.billing.requiredMinBalanceMinor
      );
      if (!hasBalance) {
        return sendApplicationError(reply, "session_requires_positive_balance", {
          message: "Top up your balance before issuing a new VPN config."
        });
      }
    }

    const body = asRecord(request.body);
    const paymentRequestId = readString(body, "paymentRequestId");
    if (deps.billing.configPaymentEnabled && !paymentRequestId) {
      return sendApplicationError(reply, "config_payment_request_required", {
        message: "A payment request ID is required to issue a paid VPN config."
      });
    }
    if (deps.billing.configPaymentEnabled && !deps.configPaymentService) {
      return sendApplicationError(reply, "config_payment_not_configured", {
        message: "SOL config payments are temporarily unavailable."
      });
    }

    const created = await createSession(
      deps.db,
      user,
      body,
      deps.selfServiceAbuseControls,
      { initialPhase: deps.billing.configPaymentEnabled ? "payment_pending" : "requested" }
    );
    if (created.status === "invalid") {
      return sendApplicationError(
        reply,
        created.error as ApplicationErrorCode,
        created.message ? { message: created.message } : {}
      );
    }

    if (deps.billing.configPaymentEnabled && deps.configPaymentService) {
      let payment;
      try {
        payment = await deps.configPaymentService.charge({
          paymentId: paymentRequestId,
          accountId: user.accountId,
          sessionId: created.sessionId
        });
      } catch (error) {
        request.log.error({ err: error, paymentRequestId, sessionId: created.sessionId }, "SOL config payment failed");
        return sendApplicationError(reply, "config_payment_unavailable", {
          message: "The SOL payment could not be confirmed. Retry Confirm with the same request."
        });
      }
      if (payment.status === "insufficient_funds") {
        await deleteUnpaidSession(deps.db, user, created.sessionId);
        return sendApplicationError(reply, "insufficient_solana_funds", {
          message: "Insufficient SOL for the 0.0001 SOL config payment and Solana network fee. Top up on Billing and try again."
        });
      }
      if (payment.status === "in_progress") {
        return sendApplicationError(reply, "config_payment_in_progress", {
          message: "The SOL payment is still being finalized. Retry Confirm shortly."
        });
      }
      if (payment.status === "failed") {
        return sendApplicationError(reply, "config_payment_unavailable", {
          message: "The SOL payment failed. Retry Confirm with the same request."
        });
      }
      const activation = await activatePaidSession(
        deps.db,
        user,
        created.sessionId,
        paymentRequestId,
        payment.signature
      );
      if (activation !== "activated" && activation !== "already_active") {
        return sendApplicationError(reply, "config_payment_unavailable", {
          message: "Payment was confirmed, but the VPN config could not be activated. Retry Confirm."
        });
      }
    }

    const session = await readOwnSession(deps.db, user.accountId, created.sessionId);
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
      return sendApplicationError(reply, "session_not_found");
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
      return sendApplicationError(reply, "session_not_found");
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
      return sendApplicationError(reply, "session_not_found");
    }
    if (result === "not_revoked") {
      return sendApplicationError(reply, "session_not_revoked");
    }
    return reply.code(204).send();
  });
}
