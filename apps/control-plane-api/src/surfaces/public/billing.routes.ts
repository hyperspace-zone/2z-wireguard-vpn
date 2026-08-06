import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import {
  errorResponseSchema,
  publicBillingSummaryResponseSchema,
  publicCreateWithdrawalRequestSchema
} from "@hyperspace-zone/contracts";
import {
  cancelOwnedWithdrawal,
  createWithdrawalRequest,
  ensureCustodialSolanaWallet,
  readAccountBillingSummary,
  type BillingConfig
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { PublicAuthUser } from "../../http/auth.js";
import { asRecord, readParam, readString } from "../../http/request.js";

export function registerPublicBillingRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<PublicAuthUser | null>;
    billing: BillingConfig;
    custodialEncryptionKey: Buffer | null;
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
    if (deps.custodialEncryptionKey) {
      await ensureCustodialSolanaWallet(deps.db, user.accountId, deps.custodialEncryptionKey);
    }
    const summary = await readAccountBillingSummary(deps.db, user.accountId, deps.billing);
    const deposit = summary.deposit
      ? {
          ...summary.deposit,
          qrSvg: await QRCode.toString(summary.deposit.address, {
            type: "svg",
            errorCorrectionLevel: "M",
            margin: 1,
            width: 240
          })
        }
      : null;
    return reply.send({ ...summary, deposit });
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
    case "invalid_withdrawal_destination": return "Enter a valid Solana withdrawal address.";
    case "active_configs_present": return "Revoke every active VPN config before starting the withdrawal cooldown.";
    case "insufficient_withdrawable_balance": return "Only unused paid balance is withdrawable; promotional credits and debt are excluded.";
    default: return "Enter a valid withdrawal amount.";
  }
}
