import type { TransactionalQueryable } from "../../db/queryable.js";
import {
  ensureBillingAccount,
  listLedgerEntries,
  readBillingBalance,
  type LedgerEntryRow
} from "../../resources/billing/repository.js";
import { findCustodialWallet } from "../../resources/wallets/repository.js";
import { availableBillingBalance } from "./prepaid-billing.scenario.js";
import {
  readBillingAccountState,
  readBillingBuckets,
  readCurrentBillingPlan,
  listAccountUsageSummaries,
  listWithdrawalRequests,
  type AccountUsageSummaryRow,
  type BillingAccountStateRow,
  type BillingBucketsRow,
  type BillingPlanVersionRow,
  type WithdrawalRequestRow
} from "../../resources/billing/prepaid-repository.js";
import { listSolanaPaymentReceipts } from "../../resources/billing/solana-deposit-repository.js";
import {
  readSolanaMinimumBalanceForRentExemption,
  readSolanaNativeBalance
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
