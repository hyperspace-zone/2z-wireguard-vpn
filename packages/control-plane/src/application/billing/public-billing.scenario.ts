import type { TransactionalQueryable } from "../../db/queryable.js";
import {
  ensureBillingAccount,
  findTopupIntentForUpdate,
  findTopupByTransactionSignature,
  insertLedgerEntry,
  listOpenTopupIntents,
  listLedgerEntries,
  readBillingBalance,
  submitTopupIntent,
  type LedgerEntryRow,
  type TopupIntentRow
} from "../../resources/billing/repository.js";
import { findCustodialWallet } from "../../resources/wallets/repository.js";
import {
  applyBucketCredit,
  availableBillingBalance
} from "./prepaid-billing.scenario.js";
import {
  readBillingAccountState,
  readBillingBuckets,
  readCurrentBillingPlan,
  insertCashSweepRequest,
  listAccountUsageSummaries,
  listWithdrawalRequests,
  type AccountUsageSummaryRow,
  type BillingAccountStateRow,
  type BillingBucketsRow,
  type BillingPlanVersionRow,
  type WithdrawalRequestRow,
  writeBillingBuckets
} from "../../resources/billing/prepaid-repository.js";
import {
  claimSolanaPaymentReceipt,
  listSolanaPaymentReceipts
} from "../../resources/billing/solana-deposit-repository.js";
import {
  createSolanaRpcRequestLimiter,
  findFinalizedSolanaSignaturesForReference,
  readSolanaMinimumBalanceForRentExemption,
  readSolanaNativeBalance,
  verifySolanaTopupTransaction
} from "./solana-rpc-verifier.js";

export interface BillingConfig {
  currency: string;
  solanaTokenSymbol: string;
  solanaTokenMint: string;
  solanaRpcUrl: string;
  solanaHistoryRpcUrl?: string;
  solanaHistoryRpcRequestsPerSecond?: number;
  solanaTokenBaseUnitsPerBillingMinor: number;
  solanaTokenDecimals: number;
  solanaExplorerTransactionBaseUrl: string;
  usageMarkupBps: number;
  solanaAssetKind?: "spl" | "native";
  configPriceLamports?: number;
  configPaymentTreasuryAddress?: string;
  configPaymentEnabled?: boolean;
  fetchImpl?: typeof fetch;
}

export interface BillingSummary {
  accountId: string;
  balanceMinor: number;
  currency: string;
  ledger: LedgerEntryRow[];
  deposit: BillingDepositDestination | null;
  deposits: BillingDeposit[];
  buckets: BillingBucketsRow;
  state: BillingAccountStateRow;
  plan: BillingPlanVersionRow;
  availableBalanceMinor: number;
  withdrawableBalanceMinor: number;
  usage: AccountUsageSummaryRow[];
  withdrawals: WithdrawalRequestRow[];
  walletBalanceBaseUnits: string | null;
  walletSpendableBaseUnits: string | null;
  walletRentReserveBaseUnits: string | null;
  configPriceBaseUnits: string;
}

export interface BillingDepositDestination {
  chain: "solana";
  address: string;
  tokenSymbol: string;
  tokenMint: string;
  tokenDecimals: number;
}

export interface BillingDeposit {
  transactionSignature: string;
  chain: "solana";
  status: "finalized";
  tokenSymbol: string;
  tokenMint: string;
  tokenAmountBaseUnits: string;
  tokenDecimals: number;
  creditedAmountMinor: number;
  currency: string;
  observedAt: string;
  explorerUrl: string;
}

type LegacyTopupFinalizationResult =
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
  const [balance, ledger, wallet, receipts, buckets, state, plan, usage, withdrawals] = await Promise.all([
    readBillingBalance(db, accountId),
    listLedgerEntries(db, accountId),
    findCustodialWallet(db, accountId),
    listSolanaPaymentReceipts(db, accountId),
    readBillingBuckets(db, accountId),
    readBillingAccountState(db, accountId),
    readCurrentBillingPlan(db, accountId),
    listAccountUsageSummaries(db, accountId),
    listWithdrawalRequests(db, accountId)
  ]);
  const nativeSolBilling = config?.solanaAssetKind === "native";
  const [nativeBalance, nativeRentReserve] = nativeSolBilling && wallet && config
    ? await Promise.all([
      safeReadNativeBalance(wallet.publicKey, config),
      safeReadNativeRentReserve(config)
    ])
    : [null, null];
  const nativeSpendable = nativeBalance !== null && nativeRentReserve !== null
    ? nativeBalance > nativeRentReserve ? nativeBalance - nativeRentReserve : 0n
    : null;
  const displayCurrency = nativeSolBilling ? "SOL" : balance.currency;
  const displayBalanceMinor = nativeSolBilling ? Number(nativeBalance ?? 0n) : balance.balanceMinor;
  const activeReceipts = config
    ? receipts.filter((receipt) => (receipt.tokenMint ?? config.solanaTokenMint) === config.solanaTokenMint)
    : [];
  return {
    accountId,
    balanceMinor: displayBalanceMinor,
    currency: displayCurrency,
    ledger,
    deposit: config && wallet && config.solanaTokenMint ? {
      chain: "solana",
      address: wallet.publicKey,
      tokenSymbol: config.solanaTokenSymbol,
      tokenMint: config.solanaTokenMint,
      tokenDecimals: config.solanaTokenDecimals
    } : null,
    deposits: config ? activeReceipts.map((receipt) => ({
      transactionSignature: receipt.transactionSignature,
      chain: "solana" as const,
      status: "finalized" as const,
      tokenSymbol: config.solanaTokenSymbol,
      tokenMint: receipt.tokenMint ?? config.solanaTokenMint,
      tokenAmountBaseUnits: receipt.amountBaseUnits
        ?? (BigInt(receipt.creditedAmountMinor) * BigInt(config.solanaTokenBaseUnitsPerBillingMinor)).toString(),
      tokenDecimals: config.solanaTokenDecimals,
      creditedAmountMinor: receipt.creditedAmountMinor,
      currency: displayCurrency,
      observedAt: receipt.observedAt,
      explorerUrl: explorerTransactionUrl(config.solanaExplorerTransactionBaseUrl, receipt.transactionSignature)
    })) : [],
    buckets,
    state,
    plan,
    availableBalanceMinor: nativeSolBilling ? Number(nativeSpendable ?? 0n) : availableBillingBalance(buckets),
    withdrawableBalanceMinor: nativeSolBilling
      ? Number(nativeSpendable ?? 0n)
      : Math.max(0, buckets.cashMinor - buckets.reservedWithdrawalMinor - buckets.debtMinor),
    usage,
    withdrawals,
    walletBalanceBaseUnits: nativeBalance?.toString() ?? null,
    walletSpendableBaseUnits: nativeSpendable?.toString() ?? null,
    walletRentReserveBaseUnits: nativeRentReserve?.toString() ?? null,
    configPriceBaseUnits: String(config?.configPriceLamports ?? 0)
  };
}

async function safeReadNativeRentReserve(config: BillingConfig): Promise<bigint | null> {
  try {
    return await readSolanaMinimumBalanceForRentExemption({
      rpcUrl: config.solanaRpcUrl,
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {})
    });
  } catch {
    return null;
  }
}

async function safeReadNativeBalance(walletAddress: string, config: BillingConfig): Promise<bigint | null> {
  try {
    return await readSolanaNativeBalance(walletAddress, {
      rpcUrl: config.solanaRpcUrl,
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {})
    });
  } catch {
    return null;
  }
}

function explorerTransactionUrl(baseUrl: string, transactionSignature: string): string {
  const normalized = baseUrl.trim() || "https://orbmarkets.io/tx/";
  return `${normalized.endsWith("/") ? normalized : `${normalized}/`}${encodeURIComponent(transactionSignature)}`;
}

export async function reconcileSubmittedSolanaTopups(
  db: TransactionalQueryable,
  config: BillingConfig
): Promise<{ checked: number; confirmed: number; pending: number; rejected: number }> {
  const result = { checked: 0, confirmed: 0, pending: 0, rejected: 0 };
  if (!config.solanaRpcUrl) {
    return result;
  }
  const historyRpcUrl = config.solanaHistoryRpcUrl || config.solanaRpcUrl;
  const historyRequestLimiter = createSolanaRpcRequestLimiter(
    config.solanaHistoryRpcRequestsPerSecond ?? 8
  );
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
          rpcUrl: historyRpcUrl,
          beforeRequest: historyRequestLimiter,
          ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {})
        });
      if (discoveredSignatures.length === 0) {
        result.pending += 1;
        continue;
      }
      let matched = false;
      for (const transactionSignature of discoveredSignatures) {
        const discoveredThroughHistory = !topup.transactionSignature;
        const verification = await verifySolanaTopupTransaction({
          transactionSignature,
          treasuryAddress: topup.treasuryAddress,
          reference: topup.reference,
          amountMinor: topup.amountMinor,
          expectedSender: topup.expectedSender
        }, {
          rpcUrl: discoveredThroughHistory ? historyRpcUrl : config.solanaRpcUrl,
          tokenMint: topup.tokenMint ?? config.solanaTokenMint,
          tokenBaseUnitsPerBillingMinor: config.solanaTokenBaseUnitsPerBillingMinor,
          searchTransactionHistory: discoveredThroughHistory,
          ...(discoveredThroughHistory ? { beforeRequest: historyRequestLimiter } : {}),
          ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {})
        });
        if (verification.status === "verified") {
          const finalized = await finalizeVerifiedTopup(db, topup.accountId, topup, transactionSignature, {
            verificationMode: "solana-rpc-finalized-worker",
            ...verification.evidence
          }, config);
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

async function finalizeVerifiedTopup(
  db: TransactionalQueryable,
  accountId: string,
  topup: TopupIntentRow,
  transactionSignature: string,
  evidence: Record<string, unknown>,
  config: BillingConfig
): Promise<LegacyTopupFinalizationResult> {
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
      const receipt = await claimSolanaPaymentReceipt(client, {
        transactionSignature,
        accountId,
        sourceType: "topup_intent",
        sourceId: locked.id,
        tokenMint: locked.tokenMint ?? config.solanaTokenMint,
        amountBaseUnits: BigInt(locked.amountMinor) * BigInt(config.solanaTokenBaseUnitsPerBillingMinor),
        creditedAmountMinor: locked.amountMinor,
        metadata: { verificationMode: evidence.verificationMode ?? "solana-rpc-finalized" }
      });
      if (!receipt.claimed && (
        receipt.receipt.sourceType !== "topup_intent"
        || receipt.receipt.sourceId !== locked.id
      )) {
        return "topup_transaction_reused";
      }
      await submitTopupIntent(client, {
        intentId: locked.id,
        status: "confirmed",
        transactionSignature,
        confirmed: true,
        metadata: { verificationStatus: "confirmed", verificationEvidence: evidence }
      });
      const inserted = await insertLedgerEntry(client, {
        accountId,
        entryType: "topup",
        amountMinor: locked.amountMinor,
        currency: locked.currency,
        sourceType: "topup_intent",
        sourceId: locked.id,
        description: "Solana balance top-up",
        metadata: { provider: locked.provider, transactionSignature, ...evidence }
      });
      if (inserted) {
        const buckets = await readBillingBuckets(client, accountId, true);
        const nextBuckets = applyBucketCredit(buckets, locked.amountMinor, "cash");
        const debtRepaidMinor = buckets.debtMinor - nextBuckets.debtMinor;
        await writeBillingBuckets(client, accountId, nextBuckets);
        await insertCashSweepRequest(client, {
          accountId,
          sourceType: "topup_debt_repayment",
          sourceId: locked.id,
          amountMinor: debtRepaidMinor,
          tokenSymbol: locked.tokenSymbol ?? config.solanaTokenSymbol,
          tokenMint: locked.tokenMint ?? config.solanaTokenMint,
          tokenAmountBaseUnits: BigInt(debtRepaidMinor) * BigInt(config.solanaTokenBaseUnitsPerBillingMinor),
          metadata: { transactionSignature, reason: "prepaid debt repayment" }
        });
      }
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

export async function accountHasSufficientBalance(
  db: TransactionalQueryable,
  accountId: string,
  minBalanceMinor: number
): Promise<boolean> {
  if (minBalanceMinor <= 0) {
    return true;
  }
  const [buckets, state] = await Promise.all([
    readBillingBuckets(db, accountId),
    readBillingAccountState(db, accountId)
  ]);
  return state.state === "active" && availableBillingBalance(buckets) >= minBalanceMinor;
}
