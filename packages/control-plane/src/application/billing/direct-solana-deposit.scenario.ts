import type { TransactionalQueryable } from "../../db/queryable.js";
import {
  ensureBillingAccount,
  insertLedgerEntry
} from "../../resources/billing/repository.js";
import {
  claimSolanaPaymentReceipt,
  readSolanaDepositRemainderForUpdate,
  readSolanaDepositScanCursor,
  recordSolanaDepositScanFailure,
  recordSolanaDepositScanSuccess,
  writeSolanaDepositRemainder
} from "../../resources/billing/solana-deposit-repository.js";
import {
  insertCashSweepRequest,
  readBillingBuckets,
  writeBillingBuckets
} from "../../resources/billing/prepaid-repository.js";
import {
  listCustodialWalletsDueForDepositScan,
  type CustodialWalletRow
} from "../../resources/wallets/repository.js";
import { applyBucketCredit } from "./prepaid-billing.scenario.js";
import type { BillingConfig } from "./public-billing.scenario.js";
import {
  createSolanaRpcRequestLimiter,
  findFinalizedSolanaSignaturesForAddress,
  findSolanaTokenAccountsByOwner,
  verifyNativeSolDirectDepositTransaction,
  verifySolanaDirectDepositTransaction,
  type SolanaAddressSignature
} from "./solana-rpc-verifier.js";

export interface DirectSolanaDepositReconcileOptions {
  batchSize: number;
  scanIntervalSeconds: number;
  retryIntervalSeconds?: number;
  retryScheduleSeconds?: number[];
  signaturePageSize?: number;
  maxSignaturePages?: number;
  walletId?: string;
}

export interface DirectSolanaDepositReconcileResult {
  walletsChecked: number;
  signaturesChecked: number;
  depositsCredited: number;
  creditedMinor: number;
  duplicates: number;
  ignored: number;
  errors: number;
}

export async function reconcileDirectSolanaDeposits(
  db: TransactionalQueryable,
  config: BillingConfig,
  options: DirectSolanaDepositReconcileOptions
): Promise<DirectSolanaDepositReconcileResult> {
  const result: DirectSolanaDepositReconcileResult = {
    walletsChecked: 0,
    signaturesChecked: 0,
    depositsCredited: 0,
    creditedMinor: 0,
    duplicates: 0,
    ignored: 0,
    errors: 0
  };
  const historyRpcUrl = config.solanaHistoryRpcUrl || config.solanaRpcUrl;
  if (!config.solanaRpcUrl || !historyRpcUrl || !config.solanaTokenMint) return result;
  const historyRequestLimiter = createSolanaRpcRequestLimiter(
    config.solanaHistoryRpcRequestsPerSecond ?? 8
  );

  const wallets = await listCustodialWalletsDueForDepositScan(
    db,
    config.solanaTokenMint,
    Math.max(1, options.batchSize),
    options.walletId
  );
  for (const wallet of wallets) {
    result.walletsChecked += 1;
    try {
      await scanWallet(db, wallet, config, historyRpcUrl, historyRequestLimiter, options, result);
    } catch (error) {
      result.errors += 1;
      await recordSolanaDepositScanFailure(db, {
        walletId: wallet.id,
        tokenMint: config.solanaTokenMint,
        error: error instanceof Error ? error.message : String(error),
        nextScanAt: afterSeconds(directDepositRetryDelaySeconds(
          (await readSolanaDepositScanCursor(db, wallet.id, config.solanaTokenMint))?.consecutiveFailures ?? 0,
          error instanceof Error && /quota_exhausted/.test(error.message)
            ? [3600]
            : options.retryScheduleSeconds
              ?? (options.retryIntervalSeconds ? [options.retryIntervalSeconds] : [60, 300, 900, 3600])
        ))
      });
    }
  }
  return result;
}

async function scanWallet(
  db: TransactionalQueryable,
  wallet: CustodialWalletRow,
  config: BillingConfig,
  historyRpcUrl: string,
  historyRequestLimiter: () => Promise<void>,
  options: DirectSolanaDepositReconcileOptions,
  result: DirectSolanaDepositReconcileResult
): Promise<void> {
  const cursor = await readSolanaDepositScanCursor(db, wallet.id, config.solanaTokenMint);
  const tokenAccounts = config.solanaAssetKind === "native"
    ? [wallet.publicKey]
    : cursor?.tokenAccounts.length
    ? cursor.tokenAccounts
    : await findSolanaTokenAccountsByOwner(wallet.publicKey, {
      rpcUrl: config.solanaRpcUrl,
      tokenMint: config.solanaTokenMint,
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {})
    });
  const latestSignatures = { ...(cursor?.latestSignatures ?? {}) };

  for (const tokenAccount of tokenAccounts) {
    const signatures = await loadNewSignatures(
      tokenAccount,
      latestSignatures[tokenAccount],
      config,
      historyRpcUrl,
      historyRequestLimiter,
      options
    );
    const walletCreatedAt = Date.parse(wallet.createdAt);
    for (const record of [...signatures].reverse()) {
      if (!cursor && record.blockTime && record.blockTime * 1000 < walletCreatedAt - 300_000) {
        continue;
      }
      result.signaturesChecked += 1;
      const verification = config.solanaAssetKind === "native"
        ? await verifyNativeSolDirectDepositTransaction({
          transactionSignature: record.signature,
          recipientOwner: wallet.publicKey
        }, {
          rpcUrl: historyRpcUrl,
          beforeRequest: historyRequestLimiter,
          searchTransactionHistory: true,
          ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {})
        })
        : await verifySolanaDirectDepositTransaction({
        transactionSignature: record.signature,
        recipientOwner: wallet.publicKey
      }, {
        rpcUrl: historyRpcUrl,
        tokenMint: config.solanaTokenMint,
        beforeRequest: historyRequestLimiter,
        searchTransactionHistory: true,
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {})
      });
      if (verification.status === "pending") {
        throw new Error(`Solana transaction ${record.signature} is not readable yet: ${verification.reason}`);
      }
      if (verification.status === "invalid") {
        result.ignored += 1;
        continue;
      }
      const credited = await creditDirectDeposit(db, wallet, record.signature, verification, config);
      if (credited.duplicate) {
        result.duplicates += 1;
      } else {
        result.depositsCredited += 1;
        result.creditedMinor += credited.amountMinor;
      }
    }
    if (signatures[0]) latestSignatures[tokenAccount] = signatures[0].signature;
  }

  await recordSolanaDepositScanSuccess(db, {
    walletId: wallet.id,
    tokenMint: config.solanaTokenMint,
    tokenAccounts,
    latestSignatures,
    nextScanAt: afterSeconds(options.scanIntervalSeconds)
  });
}

async function loadNewSignatures(
  tokenAccount: string,
  until: string | undefined,
  config: BillingConfig,
  historyRpcUrl: string,
  historyRequestLimiter: () => Promise<void>,
  options: DirectSolanaDepositReconcileOptions
): Promise<SolanaAddressSignature[]> {
  const pageSize = Math.max(1, Math.min(1000, options.signaturePageSize ?? 100));
  const maxPages = Math.max(1, options.maxSignaturePages ?? 10);
  const records: SolanaAddressSignature[] = [];
  let before: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const batch = await findFinalizedSolanaSignaturesForAddress(tokenAccount, {
      ...(until ? { until } : {}),
      ...(before ? { before } : {}),
      limit: pageSize
    }, {
      rpcUrl: historyRpcUrl,
      beforeRequest: historyRequestLimiter,
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {})
    });
    records.push(...batch);
    if (batch.length < pageSize) break;
    before = batch.at(-1)?.signature;
  }
  return records;
}

async function creditDirectDeposit(
  db: TransactionalQueryable,
  wallet: CustodialWalletRow,
  transactionSignature: string,
  verification: {
    amountBaseUnits: bigint;
    evidence: Record<string, unknown>;
  },
  config: BillingConfig
): Promise<{ duplicate: boolean; amountMinor: number }> {
  return db.transaction(async (client) => {
    await ensureBillingAccount(client, wallet.accountId, config.currency);
    const previousRemainder = await readSolanaDepositRemainderForUpdate(
      client,
      wallet.accountId,
      config.solanaTokenMint
    );
    const conversion = convertDepositToBillingMinor(
      previousRemainder,
      verification.amountBaseUnits,
      BigInt(config.solanaTokenBaseUnitsPerBillingMinor)
    );
    const claimed = await claimSolanaPaymentReceipt(client, {
      transactionSignature,
      accountId: wallet.accountId,
      sourceType: "direct_deposit",
      sourceId: transactionSignature,
      tokenMint: config.solanaTokenMint,
      amountBaseUnits: verification.amountBaseUnits,
      creditedAmountMinor: conversion.amountMinor,
      metadata: {
        verificationMode: "solana-rpc-direct-deposit",
        walletId: wallet.id,
        ...verification.evidence
      }
    });
    if (!claimed.claimed) return { duplicate: true, amountMinor: 0 };

    await writeSolanaDepositRemainder(
      client,
      wallet.accountId,
      config.solanaTokenMint,
      conversion.remainderBaseUnits
    );
    if (conversion.amountMinor <= 0) return { duplicate: false, amountMinor: 0 };

    const inserted = await insertLedgerEntry(client, {
      accountId: wallet.accountId,
      entryType: "topup",
      amountMinor: conversion.amountMinor,
      currency: config.currency,
      sourceType: "solana_direct_deposit",
      sourceId: transactionSignature,
      description: "Direct Solana balance top-up",
      metadata: {
        provider: "solana",
        transactionSignature,
        amountBaseUnits: verification.amountBaseUnits.toString(),
        remainderBaseUnitsAfter: conversion.remainderBaseUnits.toString(),
        ...verification.evidence
      }
    });
    if (!inserted) {
      throw new Error(`direct deposit ${transactionSignature} has a ledger entry without a payment receipt`);
    }
    const buckets = await readBillingBuckets(client, wallet.accountId, true);
    const nextBuckets = applyBucketCredit(buckets, conversion.amountMinor, "cash");
    const debtRepaidMinor = buckets.debtMinor - nextBuckets.debtMinor;
    await writeBillingBuckets(client, wallet.accountId, nextBuckets);
    if (config.solanaAssetKind !== "native") {
      await insertCashSweepRequest(client, {
        accountId: wallet.accountId,
        sourceType: "direct_deposit_debt_repayment",
        sourceId: transactionSignature,
        amountMinor: debtRepaidMinor,
        tokenSymbol: config.solanaTokenSymbol,
        tokenMint: config.solanaTokenMint,
        tokenAmountBaseUnits: BigInt(debtRepaidMinor) * BigInt(config.solanaTokenBaseUnitsPerBillingMinor),
        metadata: { transactionSignature, reason: "prepaid debt repayment" }
      });
    }
    return { duplicate: false, amountMinor: conversion.amountMinor };
  });
}

export function convertDepositToBillingMinor(
  previousRemainderBaseUnits: bigint,
  depositBaseUnits: bigint,
  baseUnitsPerBillingMinor: bigint
): { amountMinor: number; remainderBaseUnits: bigint } {
  if (previousRemainderBaseUnits < 0n || depositBaseUnits <= 0n || baseUnitsPerBillingMinor <= 0n) {
    throw new Error("invalid direct deposit conversion input");
  }
  const total = previousRemainderBaseUnits + depositBaseUnits;
  const amountMinorBigInt = total / baseUnitsPerBillingMinor;
  if (amountMinorBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("direct deposit amount exceeds the billing ledger range");
  }
  return {
    amountMinor: Number(amountMinorBigInt),
    remainderBaseUnits: total % baseUnitsPerBillingMinor
  };
}

function afterSeconds(seconds: number): string {
  return new Date(Date.now() + Math.max(1, seconds) * 1000).toISOString();
}

export function directDepositRetryDelaySeconds(
  consecutiveFailures: number,
  scheduleSeconds: number[],
  random = Math.random
): number {
  const schedule = scheduleSeconds.filter((value) => Number.isFinite(value) && value > 0);
  const base = schedule[Math.min(Math.max(0, consecutiveFailures), Math.max(0, schedule.length - 1))] ?? 3600;
  return Math.max(1, Math.round(base * (0.75 + random() * 0.5)));
}
