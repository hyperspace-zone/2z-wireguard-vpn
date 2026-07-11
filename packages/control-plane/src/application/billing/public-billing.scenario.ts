import type { TransactionalQueryable } from "../../db/queryable.js";
import { generateKeyPairSync } from "node:crypto";
import {
  ensureBillingAccount,
  findTopupIntentForUpdate,
  findTopupByTransactionSignature,
  insertLedgerEntry,
  insertTopupIntent,
  listOpenTopupIntents,
  listLedgerEntries,
  listTopupIntents,
  readBillingBalance,
  submitTopupIntent,
  type LedgerEntryRow,
  type TopupIntentRow
} from "../../resources/billing/repository.js";
import { findCustodialWallet } from "../../resources/wallets/repository.js";
import type { SessionOwner } from "../../resources/sessions/repository.js";
import { encodeBase58 } from "../auth/custodial-wallet.scenario.js";
import {
  findFinalizedSolanaSignaturesForReference,
  verifySolanaTopupTransaction
} from "./solana-rpc-verifier.js";

export interface BillingConfig {
  currency: string;
  solanaTreasuryAddress: string;
  solanaTokenSymbol: string;
  solanaTokenMint: string;
  solanaRpcUrl: string;
  solanaTokenBaseUnitsPerBillingMinor: number;
  solanaTokenDecimals: number;
  topupIntentTtlSeconds: number;
  allowUnverifiedTopups: boolean;
  usageMarkupBps: number;
  fetchImpl?: typeof fetch;
}

export interface BillingSummary {
  accountId: string;
  balanceMinor: number;
  currency: string;
  ledger: LedgerEntryRow[];
  topups: TopupIntentRow[];
}

export type CreateTopupResult =
  | { status: "created"; topup: TopupIntentRow }
  | "topup_provider_not_configured"
  | "invalid_topup_amount";

export type SubmitTopupResult =
  | { status: "submitted" | "confirmed"; topup: TopupIntentRow }
  | "topup_not_found"
  | "topup_expired"
  | "topup_already_final"
  | "topup_transaction_reused"
  | "topup_verification_unavailable"
  | "invalid_transaction_signature";

export async function readAccountBillingSummary(
  db: TransactionalQueryable,
  accountId: string,
  config?: BillingConfig
): Promise<BillingSummary> {
  await ensureBillingAccount(db, accountId);
  const [balance, ledger, topups] = await Promise.all([
    readBillingBalance(db, accountId),
    listLedgerEntries(db, accountId),
    listTopupIntents(db, accountId)
  ]);
  return {
    accountId,
    balanceMinor: balance.balanceMinor,
    currency: balance.currency,
    ledger,
    topups: config ? topups.map((topup) => withPaymentUrl(topup, {
      tokenDecimals: config.solanaTokenDecimals,
      tokenBaseUnitsPerBillingMinor: config.solanaTokenBaseUnitsPerBillingMinor
    })) : topups
  };
}

export async function createSolanaTopupIntent(
  db: TransactionalQueryable,
  actor: SessionOwner,
  input: {
    amountMinor: number;
    expectedSender?: string;
  },
  config: BillingConfig
): Promise<CreateTopupResult> {
  const custodialWallet = await findCustodialWallet(db, actor.accountId);
  const treasuryAddress = custodialWallet?.publicKey ?? config.solanaTreasuryAddress;
  if (!treasuryAddress || !config.solanaTokenMint) {
    return "topup_provider_not_configured";
  }
  if (!Number.isInteger(input.amountMinor) || input.amountMinor < 100 || input.amountMinor > 10_000_00) {
    return "invalid_topup_amount";
  }

  await ensureBillingAccount(db, actor.accountId, config.currency);
  const expiresAt = new Date(Date.now() + config.topupIntentTtlSeconds * 1000).toISOString();
  const reference = newSolanaReference();
  const topupInput = {
    accountId: actor.accountId,
    provider: "solana",
    status: "pending",
    amountMinor: input.amountMinor,
    currency: config.currency,
    chain: "solana",
    tokenSymbol: config.solanaTokenSymbol,
    tokenMint: config.solanaTokenMint,
    treasuryAddress,
    reference,
    expiresAt,
    metadata: { createdBy: actor.id }
  };
  const topup = await insertTopupIntent(db, input.expectedSender
    ? { ...topupInput, expectedSender: input.expectedSender }
    : topupInput);
  return { status: "created", topup: withPaymentUrl(topup, {
    tokenDecimals: config.solanaTokenDecimals,
    tokenBaseUnitsPerBillingMinor: config.solanaTokenBaseUnitsPerBillingMinor
  }) };
}

export async function submitSolanaTopupSignature(
  db: TransactionalQueryable,
  actor: SessionOwner,
  input: {
    topupId: string;
    transactionSignature: string;
  },
  config: BillingConfig
): Promise<SubmitTopupResult> {
  const transactionSignature = input.transactionSignature.trim();
  if (!isLikelySolanaSignature(transactionSignature)) {
    return "invalid_transaction_signature";
  }

  const topup = await findTopupIntentForUpdate(db, actor.accountId, input.topupId);
  if (!topup) {
    return "topup_not_found";
  }
  const validation = validateTopupState(topup, transactionSignature);
  if (validation) {
    return validation;
  }

  if (config.allowUnverifiedTopups && !config.solanaRpcUrl) {
    return finalizeVerifiedTopup(db, actor.accountId, topup, transactionSignature, {
      verificationMode: "explicit-unverified-testnet"
    });
  }
  if (!config.solanaRpcUrl) {
    return "topup_verification_unavailable";
  }

  let verification;
  try {
    verification = await verifySolanaTopupTransaction({
      transactionSignature,
      treasuryAddress: topup.treasuryAddress ?? "",
      reference: topup.reference,
      amountMinor: topup.amountMinor,
      expectedSender: topup.expectedSender
    }, {
      rpcUrl: config.solanaRpcUrl,
      tokenMint: topup.tokenMint ?? config.solanaTokenMint,
      tokenBaseUnitsPerBillingMinor: config.solanaTokenBaseUnitsPerBillingMinor,
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {})
    });
  } catch {
    return "topup_verification_unavailable";
  }
  if (verification.status === "invalid") {
    return "invalid_transaction_signature";
  }
  if (verification.status === "pending") {
    await submitTopupIntent(db, {
      intentId: topup.id,
      status: "submitted",
      transactionSignature,
      confirmed: false,
      metadata: { verificationStatus: "pending", verificationReason: verification.reason }
    });
    const updated = await findTopupIntentForUpdate(db, actor.accountId, topup.id);
    if (!updated) {
      throw new Error("top-up disappeared after submission");
    }
    return { status: "submitted", topup: updated };
  }
  return finalizeVerifiedTopup(db, actor.accountId, topup, transactionSignature, {
    verificationMode: "solana-rpc-finalized",
    ...verification.evidence
  });
}

export async function reconcileSubmittedSolanaTopups(
  db: TransactionalQueryable,
  config: BillingConfig
): Promise<{ checked: number; confirmed: number; pending: number; rejected: number }> {
  const result = { checked: 0, confirmed: 0, pending: 0, rejected: 0 };
  if (!config.solanaRpcUrl) {
    return result;
  }
  for (const topup of await listOpenTopupIntents(db)) {
    result.checked += 1;
    if (!topup.treasuryAddress) {
      result.rejected += 1;
      continue;
    }
    if (Date.parse(topup.expiresAt) <= Date.now()) {
      await submitTopupIntent(db, {
        intentId: topup.id,
        status: "expired",
        transactionSignature: topup.transactionSignature,
        confirmed: false
      });
      result.rejected += 1;
      continue;
    }
    try {
      const discoveredSignatures = topup.transactionSignature
        ? [topup.transactionSignature]
        : await findFinalizedSolanaSignaturesForReference(topup.reference, {
          rpcUrl: config.solanaRpcUrl,
          ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {})
        });
      if (discoveredSignatures.length === 0) {
        result.pending += 1;
        continue;
      }
      let matched = false;
      for (const transactionSignature of discoveredSignatures) {
        const verification = await verifySolanaTopupTransaction({
          transactionSignature,
          treasuryAddress: topup.treasuryAddress,
          reference: topup.reference,
          amountMinor: topup.amountMinor,
          expectedSender: topup.expectedSender
        }, {
          rpcUrl: config.solanaRpcUrl,
          tokenMint: topup.tokenMint ?? config.solanaTokenMint,
          tokenBaseUnitsPerBillingMinor: config.solanaTokenBaseUnitsPerBillingMinor,
          ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {})
        });
        if (verification.status === "verified") {
          const finalized = await finalizeVerifiedTopup(db, topup.accountId, topup, transactionSignature, {
            verificationMode: "solana-rpc-finalized-worker",
            ...verification.evidence
          });
          if (typeof finalized !== "string") {
            result.confirmed += 1;
            matched = true;
            break;
          } else {
            result.rejected += 1;
          }
        } else if (verification.status === "pending") {
          // Keep checking other signatures carrying the same reference.
        }
      }
      if (!matched && discoveredSignatures.length > 0) {
        result.pending += 1;
      }
    } catch {
      result.pending += 1;
    }
  }
  return result;
}

function newSolanaReference(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  if (!publicJwk.x) {
    throw new Error("generated Solana Pay reference is missing public key material");
  }
  return encodeBase58(Buffer.from(publicJwk.x, "base64url"));
}

function withPaymentUrl(
  topup: TopupIntentRow,
  config: { tokenDecimals: number; tokenBaseUnitsPerBillingMinor: number }
): TopupIntentRow {
  if (!topup.treasuryAddress || !topup.tokenMint) {
    return topup;
  }
  const amountBaseUnits = BigInt(topup.amountMinor) * BigInt(config.tokenBaseUnitsPerBillingMinor);
  const amount = formatTokenAmount(amountBaseUnits, config.tokenDecimals);
  const query = new URLSearchParams({
    amount,
    "spl-token": topup.tokenMint,
    reference: topup.reference,
    memo: topup.reference,
    label: "Hyperspace VPN balance",
    message: `Top up ${topup.currency} ${String((topup.amountMinor / 100).toFixed(2))}`
  });
  return { ...topup, paymentUrl: `solana:${topup.treasuryAddress}?${query.toString()}` };
}

function formatTokenAmount(baseUnits: bigint, decimals: number): string {
  const safeDecimals = Number.isInteger(decimals) && decimals >= 0 ? decimals : 0;
  if (safeDecimals === 0) {
    return baseUnits.toString();
  }
  const value = baseUnits.toString().padStart(safeDecimals + 1, "0");
  const whole = value.slice(0, -safeDecimals);
  const fraction = value.slice(-safeDecimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

async function finalizeVerifiedTopup(
  db: TransactionalQueryable,
  accountId: string,
  topup: TopupIntentRow,
  transactionSignature: string,
  evidence: Record<string, unknown>
): Promise<SubmitTopupResult> {
  try {
    return await db.transaction(async (client) => {
      const locked = await findTopupIntentForUpdate(client, accountId, topup.id);
      if (!locked) {
        return "topup_not_found";
      }
      if (locked.status === "confirmed") {
        return { status: "confirmed", topup: locked };
      }
      const reused = await findTopupByTransactionSignature(client, transactionSignature);
      if (reused && reused.id !== locked.id) {
        return "topup_transaction_reused";
      }
      await submitTopupIntent(client, {
        intentId: locked.id,
        status: "confirmed",
        transactionSignature,
        confirmed: true,
        metadata: { verificationStatus: "confirmed", verificationEvidence: evidence }
      });
      await insertLedgerEntry(client, {
        accountId,
        entryType: "topup",
        amountMinor: locked.amountMinor,
        currency: locked.currency,
        sourceType: "topup_intent",
        sourceId: locked.id,
        description: "Solana balance top-up",
        metadata: { provider: locked.provider, transactionSignature, ...evidence }
      });
      const updated = await findTopupIntentForUpdate(client, accountId, locked.id);
      if (!updated) {
        throw new Error("top-up disappeared after confirmation");
      }
      return { status: "confirmed", topup: updated };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return "topup_transaction_reused";
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

function validateTopupState(topup: TopupIntentRow, transactionSignature: string): Extract<SubmitTopupResult, string> | null {
  if (["confirmed", "expired", "cancelled", "rejected"].includes(topup.status)) {
    return "topup_already_final";
  }
  if (Date.parse(topup.expiresAt) <= Date.now()) {
    return "topup_expired";
  }
  if (topup.transactionSignature && topup.transactionSignature !== transactionSignature) {
    return "topup_already_final";
  }
  return null;
}

export async function accountHasSufficientBalance(
  db: TransactionalQueryable,
  accountId: string,
  minBalanceMinor: number
): Promise<boolean> {
  if (minBalanceMinor <= 0) {
    return true;
  }
  const balance = await readBillingBalance(db, accountId);
  return balance.balanceMinor >= minBalanceMinor;
}

function isLikelySolanaSignature(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{64,120}$/.test(value) || /^[A-Za-z0-9+/]{80,90}={0,2}$/.test(value);
}
