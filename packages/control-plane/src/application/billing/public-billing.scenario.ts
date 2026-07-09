import type { TransactionalQueryable } from "../../db/queryable.js";
import { newSecretToken } from "../../security/tokens.js";
import {
  ensureBillingAccount,
  findTopupIntentForUpdate,
  insertLedgerEntry,
  insertTopupIntent,
  listLedgerEntries,
  listTopupIntents,
  readBillingBalance,
  submitTopupIntent,
  type LedgerEntryRow,
  type TopupIntentRow
} from "../../resources/billing/repository.js";
import type { SessionOwner } from "../../resources/sessions/repository.js";

export interface BillingConfig {
  currency: string;
  solanaTreasuryAddress: string;
  solanaTokenSymbol: string;
  solanaTokenMint: string;
  topupIntentTtlSeconds: number;
  allowUnverifiedTopups: boolean;
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
  | "invalid_transaction_signature";

export async function readAccountBillingSummary(
  db: TransactionalQueryable,
  accountId: string
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
    topups
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
  if (!config.solanaTreasuryAddress || !config.solanaTokenMint) {
    return "topup_provider_not_configured";
  }
  if (!Number.isInteger(input.amountMinor) || input.amountMinor < 100 || input.amountMinor > 10_000_00) {
    return "invalid_topup_amount";
  }

  await ensureBillingAccount(db, actor.accountId, config.currency);
  const expiresAt = new Date(Date.now() + config.topupIntentTtlSeconds * 1000).toISOString();
  const reference = `hs_${newSecretToken(18)}`;
  const topupInput = {
    accountId: actor.accountId,
    provider: "solana",
    status: "pending",
    amountMinor: input.amountMinor,
    currency: config.currency,
    chain: "solana",
    tokenSymbol: config.solanaTokenSymbol,
    tokenMint: config.solanaTokenMint,
    treasuryAddress: config.solanaTreasuryAddress,
    reference,
    expiresAt,
    metadata: { createdBy: actor.id }
  };
  const topup = await insertTopupIntent(db, input.expectedSender
    ? { ...topupInput, expectedSender: input.expectedSender }
    : topupInput);
  return { status: "created", topup };
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

  return db.transaction(async (client) => {
    const topup = await findTopupIntentForUpdate(client, actor.accountId, input.topupId);
    if (!topup) {
      return "topup_not_found";
    }
    if (topup.status === "confirmed" || topup.status === "expired" || topup.status === "cancelled") {
      return "topup_already_final";
    }
    if (Date.parse(topup.expiresAt) <= Date.now()) {
      await submitTopupIntent(client, {
        intentId: topup.id,
        status: "expired",
        transactionSignature,
        confirmed: false
      });
      return "topup_expired";
    }

    const confirmed = config.allowUnverifiedTopups;
    await submitTopupIntent(client, {
      intentId: topup.id,
      status: confirmed ? "confirmed" : "submitted",
      transactionSignature,
      confirmed
    });
    if (confirmed) {
      await insertLedgerEntry(client, {
        accountId: actor.accountId,
        entryType: "topup",
        amountMinor: topup.amountMinor,
        currency: topup.currency,
        sourceType: "topup_intent",
        sourceId: topup.id,
        description: "Solana balance top-up",
        metadata: {
          provider: topup.provider,
          transactionSignature,
          verificationMode: "unverified-testnet"
        }
      });
    }

    const updated = await findTopupIntentForUpdate(client, actor.accountId, input.topupId);
    if (!updated) {
      throw new Error("top-up disappeared after update");
    }
    return { status: confirmed ? "confirmed" : "submitted", topup: updated };
  });
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
