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
  readAccountNativeWalletBalance,
  type BillingConfig
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { PublicAuthUser } from "../../http/auth.js";
import { asRecord, readParam, readQuery, readString } from "../../http/request.js";
import { createAsyncReadCache } from "../../http/async-read-cache.js";
import { createReadTiming } from "../../http/read-timing.js";

export function registerPublicBillingRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<PublicAuthUser | null>;
    billing: BillingConfig;
    custodialEncryptionKey: Buffer | null;
  }
): void {
  // Only immutable public-address QR images are cached, never wallet balances.
  const qrCache = createAsyncReadCache<string>(24 * 60 * 60_000, 128);
  const qr = (address: string) => qrCache.get(address, () => QRCode.toString(address, {
    type: "svg", errorCorrectionLevel: "M", margin: 1, width: 240
  }));
  app.addHook("onReady", async () => {
    try {
      await qr("11111111111111111111111111111111");
      // Warm a bounded set of public-address QR images before accepting traffic.
      // Recent visitors do not pay QR/JIT startup cost; new addresses stay lazy.
      const addresses = await deps.db.query<{ publicKey: string }>(`
        SELECT custodial_wallets.public_key AS "publicKey"
        FROM custodial_wallets
        JOIN users ON users.account_id = custodial_wallets.account_id AND users.disabled_at IS NULL
        LEFT JOIN auth_sessions ON auth_sessions.user_id = users.id
          AND auth_sessions.revoked_at IS NULL AND auth_sessions.expires_at > now()
        WHERE custodial_wallets.chain = 'solana'
        GROUP BY custodial_wallets.id
        ORDER BY MAX(auth_sessions.last_seen_at) DESC NULLS LAST, custodial_wallets.created_at DESC
        LIMIT 16
      `);
      for (const address of addresses.rows) await qr(address.publicKey);
    } catch {
      app.log.warn("Deposit QR warmup unavailable; images will load on demand");
    }
  });
  app.get("/v1/public/billing", {
    schema: {
      response: {
        200: publicBillingSummaryResponseSchema,
        401: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const measure = createReadTiming(reply);
    const user = await measure("auth", () => deps.requireUser(request, reply));
    if (!user) {
      return;
    }
    if (deps.custodialEncryptionKey) {
      await measure("wallet", () => ensureCustodialSolanaWallet(deps.db, user.accountId, deps.custodialEncryptionKey!));
    }
    const summary = await measure("summary", () => readAccountBillingSummary(deps.db, user.accountId, deps.billing, {
      includeNativeBalance: readQuery(request, "walletBalance") !== "deferred"
    }));
    const deposit = summary.deposit
      ? {
          ...summary.deposit,
          qrSvg: await measure("qr", () => qr(summary.deposit!.address))
        }
      : null;
    return reply.send({ ...summary, deposit });
  });

  app.get("/v1/public/billing/wallet-balance", async (request, reply) => {
    const user = await deps.requireUser(request, reply);
    if (!user) return;
    return reply.send(await readAccountNativeWalletBalance(deps.db, user.accountId, deps.billing));
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
