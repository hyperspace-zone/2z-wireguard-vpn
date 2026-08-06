import type { TransactionalQueryable } from "../../db/queryable.js";
import { decryptJsonPayload } from "@hyperspace-zone/shared";
import { insertLedgerEntry } from "../../resources/billing/repository.js";
import { readCustodialWalletEncryptedKey } from "../../resources/wallets/repository.js";
import type { SessionOwner } from "../../resources/sessions/repository.js";
import { normalizeSolanaPublicKey } from "./solana-address.js";
import {
  cancelWithdrawalRequest,
  advanceWithdrawalCooldowns,
  claimReadyWithdrawal,
  enqueueBillingNotification,
  findWithdrawalForUpdate,
  insertWithdrawalRequest,
  listSubmittedWithdrawals,
  listNonTerminalAccountSessions,
  readBillingBuckets,
  readCurrentBillingPlan,
  markWithdrawalConfirmed,
  markWithdrawalFailed,
  markWithdrawalSubmitted,
  writeBillingBuckets,
  type WithdrawalRequestRow
} from "../../resources/billing/prepaid-repository.js";

export type CreateWithdrawalResult =
  | { status: "created"; withdrawal: WithdrawalRequestRow }
  | "invalid_withdrawal_amount"
  | "invalid_withdrawal_destination"
  | "active_configs_present"
  | "insufficient_withdrawable_balance";

export async function createWithdrawalRequest(
  db: TransactionalQueryable,
  actor: SessionOwner,
  input: { amountMinor: number; destinationAddress: string },
  config: {
    solanaTokenSymbol: string;
    solanaTokenMint: string;
    solanaTokenBaseUnitsPerBillingMinor: number;
  },
  now = new Date()
): Promise<CreateWithdrawalResult> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    return "invalid_withdrawal_amount";
  }
  const destinationAddress = normalizeSolanaPublicKey(input.destinationAddress);
  if (!destinationAddress) {
    return "invalid_withdrawal_destination";
  }
  return db.transaction(async (client) => {
    if ((await listNonTerminalAccountSessions(client, actor.accountId)).length > 0) {
      return "active_configs_present";
    }
    const [buckets, plan] = await Promise.all([
      readBillingBuckets(client, actor.accountId, true),
      readCurrentBillingPlan(client, actor.accountId)
    ]);
    const withdrawable = buckets.cashMinor - buckets.reservedWithdrawalMinor;
    if (buckets.debtMinor > 0 || input.amountMinor < plan.minimumWithdrawalMinor || input.amountMinor > withdrawable) {
      return "insufficient_withdrawable_balance";
    }
    const eligibleAt = new Date(now.getTime() + plan.withdrawalCooldownSeconds * 1000).toISOString();
    const withdrawal = await insertWithdrawalRequest(client, {
      accountId: actor.accountId,
      userId: actor.id,
      amountMinor: input.amountMinor,
      tokenSymbol: config.solanaTokenSymbol,
      tokenMint: config.solanaTokenMint,
      tokenAmountBaseUnits: BigInt(input.amountMinor) * BigInt(config.solanaTokenBaseUnitsPerBillingMinor),
      destinationAddress,
      eligibleAt
    });
    await writeBillingBuckets(client, actor.accountId, {
      ...buckets,
      reservedWithdrawalMinor: buckets.reservedWithdrawalMinor + input.amountMinor
    });
    await enqueueBillingNotification(client, {
      accountId: actor.accountId,
      notificationType: "billing_withdrawal_requested",
      dedupeKey: `billing-withdrawal-requested:${withdrawal.id}`,
      payload: {
        withdrawalId: withdrawal.id,
        amountMinor: input.amountMinor,
        destinationAddress,
        eligibleAt
      }
    });
    return { status: "created", withdrawal };
  });
}

export async function cancelOwnedWithdrawal(
  db: TransactionalQueryable,
  actor: SessionOwner,
  withdrawalId: string
): Promise<"cancelled" | "not_found" | "not_cancellable"> {
  return db.transaction(async (client) => {
    const withdrawal = await findWithdrawalForUpdate(client, actor.accountId, withdrawalId);
    if (!withdrawal) return "not_found";
    if (!['cooldown', 'ready', 'failed'].includes(withdrawal.status)) return "not_cancellable";
    const buckets = await readBillingBuckets(client, actor.accountId, true);
    await cancelWithdrawalRequest(client, withdrawal.id);
    await writeBillingBuckets(client, actor.accountId, {
      ...buckets,
      reservedWithdrawalMinor: Math.max(0, buckets.reservedWithdrawalMinor - withdrawal.amountMinor)
    });
    return "cancelled";
  });
}

export interface WithdrawalSigningJob {
  withdrawal: WithdrawalRequestRow & { accountId: string };
  sourceWalletAddress: string;
  sourceWalletSeed: Uint8Array;
}

export async function claimWithdrawalSigningJob(
  db: TransactionalQueryable,
  encryptionKey: Buffer
): Promise<WithdrawalSigningJob | null> {
  return db.transaction(async (client) => {
    await advanceWithdrawalCooldowns(client);
    const withdrawal = await claimReadyWithdrawal(client);
    if (!withdrawal) return null;
    const keyRecord = await readCustodialWalletEncryptedKey(client, withdrawal.accountId);
    if (!keyRecord) {
      await markWithdrawalFailed(client, withdrawal.id, "custodial wallet key not found");
      return null;
    }
    const decrypted = decryptJsonPayload<{ seed: string; format: string }>(keyRecord.encryptedKey, encryptionKey);
    if (decrypted.format !== "ed25519-jwk-seed-v1") {
      await markWithdrawalFailed(client, withdrawal.id, "unsupported custodial wallet key format");
      return null;
    }
    return {
      withdrawal,
      sourceWalletAddress: keyRecord.wallet.publicKey,
      sourceWalletSeed: Buffer.from(decrypted.seed, "base64url")
    };
  });
}

export async function recordWithdrawalSubmission(
  db: TransactionalQueryable,
  withdrawalId: string,
  transactionSignature: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await markWithdrawalSubmitted(db, withdrawalId, transactionSignature, metadata);
}

export async function failWithdrawalSubmission(
  db: TransactionalQueryable,
  withdrawalId: string,
  error: string
): Promise<void> {
  await markWithdrawalFailed(db, withdrawalId, error);
}

export async function listWithdrawalConfirmations(db: TransactionalQueryable) {
  return listSubmittedWithdrawals(db);
}

export async function confirmWithdrawal(
  db: TransactionalQueryable,
  withdrawal: WithdrawalRequestRow & { accountId: string }
): Promise<void> {
  await db.transaction(async (client) => {
    const locked = await findWithdrawalForUpdate(client, withdrawal.accountId, withdrawal.id);
    if (!locked || locked.status === "confirmed") return;
    if (locked.status !== "submitted") throw new Error("withdrawal is not submitted");
    const buckets = await readBillingBuckets(client, withdrawal.accountId, true);
    if (buckets.cashMinor < locked.amountMinor || buckets.reservedWithdrawalMinor < locked.amountMinor) {
      throw new Error("withdrawal reservation invariant failed");
    }
    const inserted = await insertLedgerEntry(client, {
      accountId: withdrawal.accountId,
      entryType: "withdrawal",
      amountMinor: -locked.amountMinor,
      currency: locked.currency,
      sourceType: "withdrawal_request",
      sourceId: locked.id,
      description: `Solana ${locked.tokenSymbol} withdrawal`,
      metadata: { transactionSignature: locked.transactionSignature, destinationAddress: locked.destinationAddress }
    });
    if (inserted) {
      await writeBillingBuckets(client, withdrawal.accountId, {
        ...buckets,
        cashMinor: buckets.cashMinor - locked.amountMinor,
        reservedWithdrawalMinor: buckets.reservedWithdrawalMinor - locked.amountMinor
      });
    }
    await markWithdrawalConfirmed(client, locked.id);
    await enqueueBillingNotification(client, {
      accountId: withdrawal.accountId,
      notificationType: "billing_withdrawal_confirmed",
      dedupeKey: `billing-withdrawal-confirmed:${locked.id}`,
      payload: {
        withdrawalId: locked.id,
        amountMinor: locked.amountMinor,
        destinationAddress: locked.destinationAddress,
        transactionSignature: locked.transactionSignature
      }
    });
  });
}
