import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  errorResponseSchema,
  publicBillingSummaryResponseSchema,
  publicCreateWithdrawalRequestSchema,
  publicCreateTopupRequestSchema,
  publicSubmitTopupRequestSchema,
  publicTopupIntentResponseSchema
} from "@hyperspace-zone/contracts";
import {
  createSolanaTopupIntent,
  cancelOwnedWithdrawal,
  createWithdrawalRequest,
  readAccountBillingSummary,
  submitSolanaTopupSignature,
  type BillingConfig
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { PublicAuthUser } from "../../http/auth.js";
import { sendApplicationError } from "../../http/errors.js";
import { asRecord, readParam, readString } from "../../http/request.js";

export function registerPublicBillingRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<PublicAuthUser | null>;
    billing: BillingConfig;
  }
): void {
  app.get("/v1/public/billing", {
    schema: {
      response: {
        200: publicBillingSummaryResponseSchema,
        401: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const user = await deps.requireUser(request, reply);
    if (!user) {
      return;
    }
    return reply.send(await readAccountBillingSummary(deps.db, user.accountId, deps.billing));
  });

  app.post("/v1/public/billing/topups", {
    schema: {
      body: publicCreateTopupRequestSchema,
      response: {
        201: publicTopupIntentResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        503: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const user = await deps.requireUser(request, reply);
    if (!user) {
      return;
    }
    const body = asRecord(request.body);
    const expectedSender = readString(body, "expectedSender");
    const result = await createSolanaTopupIntent(deps.db, user, {
      amountMinor: readAmountMinor(body),
      ...(expectedSender ? { expectedSender } : {})
    }, deps.billing);
    if (result === "topup_provider_not_configured") {
      return sendApplicationError(reply, "topup_provider_not_configured");
    }
    if (result === "invalid_topup_amount") {
      return sendApplicationError(reply, "invalid_topup_amount");
    }
    return reply.code(201).send({ topup: result.topup });
  });

  app.post("/v1/public/billing/topups/:topupId/submit", {
    schema: {
      body: publicSubmitTopupRequestSchema,
      response: {
        200: publicTopupIntentResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        404: errorResponseSchema,
        409: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const user = await deps.requireUser(request, reply);
    if (!user) {
      return;
    }
    const body = asRecord(request.body);
    const result = await submitSolanaTopupSignature(deps.db, user, {
      topupId: readParam(request, "topupId"),
      transactionSignature: readString(body, "transactionSignature")
    }, deps.billing);
    if (typeof result === "string") {
      switch (result) {
        case "topup_not_found":
          return sendApplicationError(reply, "topup_not_found");
        case "topup_expired":
          return sendApplicationError(reply, "topup_expired");
        case "topup_already_final":
          return sendApplicationError(reply, "topup_already_final");
        case "topup_transaction_reused":
          return sendApplicationError(reply, "topup_transaction_reused");
        case "topup_verification_unavailable":
          return sendApplicationError(reply, "topup_verification_unavailable");
        default:
          return sendApplicationError(reply, "invalid_transaction_signature");
      }
    }
    return reply.send({ topup: result.topup });
  });

  app.post("/v1/public/billing/withdrawals", {
    schema: {
      body: publicCreateWithdrawalRequestSchema,
      response: {
        201: { type: "object", additionalProperties: true },
        400: errorResponseSchema,
        401: errorResponseSchema,
        409: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const user = await deps.requireUser(request, reply);
    if (!user) return;
    const body = asRecord(request.body);
    const result = await createWithdrawalRequest(deps.db, user, {
      amountMinor: readAmountMinor(body),
      destinationAddress: readString(body, "destinationAddress")
    }, deps.billing);
    if (typeof result === "string") {
      const status = result === "active_configs_present" || result === "insufficient_withdrawable_balance" ? 409 : 400;
      return reply.code(status).send({ error: result, message: withdrawalErrorMessage(result) });
    }
    return reply.code(201).send({ withdrawal: result.withdrawal });
  });

  app.delete("/v1/public/billing/withdrawals/:withdrawalId", async (request, reply) => {
    const user = await deps.requireUser(request, reply);
    if (!user) return;
    const result = await cancelOwnedWithdrawal(deps.db, user, readParam(request, "withdrawalId"));
    if (result === "not_found") return reply.code(404).send({ error: result, message: "Withdrawal was not found." });
    if (result === "not_cancellable") return reply.code(409).send({ error: result, message: "Withdrawal can no longer be cancelled." });
    return reply.send({ status: result });
  });
}

function readAmountMinor(record: Record<string, unknown>): number {
  const value = record.amountMinor;
  return typeof value === "number" ? Math.round(value) : Number.NaN;
}

function withdrawalErrorMessage(error: string): string {
  switch (error) {
    case "withdrawal_destination_not_linked": return "Link this Solana wallet before requesting a withdrawal.";
    case "active_configs_present": return "Revoke every active VPN config before starting the withdrawal cooldown.";
    case "insufficient_withdrawable_balance": return "Only unused paid balance is withdrawable; promotional credits and debt are excluded.";
    default: return "Enter a valid withdrawal amount.";
  }
}
