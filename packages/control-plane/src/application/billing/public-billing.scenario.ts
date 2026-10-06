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
  ensurePrepaidBillingState,
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
  configTrafficLimitBytes?: number;
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
  walletBalanceStatus?: "loading" | "available" | "unavailable" | "not_applicable";
  configPriceBaseUnits: string;
  configTrafficLimitBytes: string;
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
  config?: BillingConfig,
  options: { includeNativeBalance?: boolean } = {}
): Promise<BillingSummary> {
  await Promise.all([ensureBillingAccount(db, accountId), ensurePrepaidBillingState(db, accountId)]);
  const [balance, ledger, wallet, receipts, buckets, state, plan, usage, withdrawals] = await Promise.all([
    readBillingBalance(db, accountId, true),
    listLedgerEntries(db, accountId),
    findCustodialWallet(db, accountId),
    listSolanaPaymentReceipts(db, accountId),
    readBillingBuckets(db, accountId, false, true),
    readBillingAccountState(db, accountId, false, true),
    readCurrentBillingPlan(db, accountId, true),
    listAccountUsageSummaries(db, accountId),
    listWithdrawalRequests(db, accountId)
  ]);
  const nativeSolBilling = config?.solanaAssetKind === "native";
  const [nativeBalance, nativeRentReserve] = options.includeNativeBalance !== false && nativeSolBilling && wallet && config
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
    walletBalanceStatus: !nativeSolBilling ? "not_applicable" : options.includeNativeBalance === false ? "loading"
      : nativeSpendable !== null ? "available" : "unavailable",
    configPriceBaseUnits: String(config?.configPriceLamports ?? 0),
    configTrafficLimitBytes: String(config?.configTrafficLimitBytes ?? 0)
  };
}

// Display-only read. Payments and withdrawals continue to perform their own
// fresh authorization checks; no private balances are cached here.
export async function readAccountNativeWalletBalance(db: TransactionalQueryable, accountId: string, config: BillingConfig) {
  const wallet = config.solanaAssetKind === "native" ? await findCustodialWallet(db, accountId) : null;
  const [balance, rent] = wallet ? await Promise.all([
    safeReadNativeBalance(wallet.publicKey, config), safeReadNativeRentReserve(config)
  ]) : [null, null];
  const spendable = balance !== null && rent !== null ? balance > rent ? balance - rent : 0n : null;
  return {
    walletBalanceBaseUnits: balance?.toString() ?? null,
    walletSpendableBaseUnits: spendable?.toString() ?? null,
    walletRentReserveBaseUnits: rent?.toString() ?? null,
    walletBalanceStatus: config.solanaAssetKind !== "native" ? "not_applicable" : spendable !== null ? "available" : "unavailable",
    walletBalanceCheckedAt: new Date().toISOString()
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
