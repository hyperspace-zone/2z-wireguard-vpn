import type { TransactionalQueryable } from "../../db/queryable.js";
import { insertLedgerEntry } from "../../resources/billing/repository.js";
import {
  enqueueBillingNotification,
  insertRetailUsageRating,
  listBillingAccountsNeedingStateCheck,
  listNonTerminalAccountSessions,
  listRetailRatingCandidates,
  lockBillingAccrual,
  markRatingPosted,
  readBillingAccountState,
  readBillingBuckets,
  readCurrentBillingPlan,
  updateBillingAccountState,
  updateBillingAccrual,
  writeBillingBuckets,
  type BillingBucketsRow,
  type RetailRatingCandidateRow
} from "../../resources/billing/prepaid-repository.js";
import { requestSystemSessionRevocation } from "../../resources/sessions/service.js";

const MICROMINOR_PER_MINOR = 1_000_000n;
const BILLING_MONTH_SECONDS = 30n * 24n * 60n * 60n;
const BYTES_PER_DECIMAL_GB = 1_000_000_000n;

export interface RetailBillingRuntimeConfig {
  mode: "shadow" | "enforce";
  settlementLagSeconds: number;
  batchSize?: number;
}

export interface RetailBillingSettlementResult {
  mode: "shadow" | "enforce";
  ratedWindows: number;
  postedMinor: number;
  graceStarted: number;
  suspended: number;
  restored: number;
}

export function calculateRetailChargeMicrominor(input: {
  activeSeconds: number;
  activeConfigMonthlyMinor: number;
  bytesToDestination: bigint;
  bytesFromDestination: bigint;
  trafficPerGbMinor: number;
}): bigint {
  const activeSeconds = BigInt(Math.max(0, Math.trunc(input.activeSeconds)));
  const monthlyMinor = BigInt(Math.max(0, Math.trunc(input.activeConfigMonthlyMinor)));
  const trafficPerGbMinor = BigInt(Math.max(0, Math.trunc(input.trafficPerGbMinor)));
  const payloadBytes = nonNegative(input.bytesToDestination) + nonNegative(input.bytesFromDestination);
  const activeCharge = activeSeconds * monthlyMinor * MICROMINOR_PER_MINOR / BILLING_MONTH_SECONDS;
  const trafficCharge = payloadBytes * trafficPerGbMinor * MICROMINOR_PER_MINOR / BYTES_PER_DECIMAL_GB;
  return activeCharge + trafficCharge;
}

export function consumeBillingCharge(buckets: BillingBucketsRow, chargeMinor: number): BillingBucketsRow {
  let remaining = Math.max(0, Math.trunc(chargeMinor));
  const promotionalSpend = Math.min(buckets.promotionalMinor, remaining);
  remaining -= promotionalSpend;
  const spendableCash = Math.max(0, buckets.cashMinor - buckets.reservedWithdrawalMinor);
  const cashSpend = Math.min(spendableCash, remaining);
  remaining -= cashSpend;
  return {
    ...buckets,
    promotionalMinor: buckets.promotionalMinor - promotionalSpend,
    cashMinor: buckets.cashMinor - cashSpend,
    debtMinor: buckets.debtMinor + remaining
  };
}

export function applyBucketCredit(
  buckets: BillingBucketsRow,
  amountMinor: number,
  kind: "cash" | "promotional"
): BillingBucketsRow {
  let remaining = Math.max(0, Math.trunc(amountMinor));
  const debtPayment = Math.min(buckets.debtMinor, remaining);
  remaining -= debtPayment;
  return {
    ...buckets,
    debtMinor: buckets.debtMinor - debtPayment,
    cashMinor: buckets.cashMinor + (kind === "cash" ? remaining : 0),
    promotionalMinor: buckets.promotionalMinor + (kind === "promotional" ? remaining : 0)
  };
}

export function availableBillingBalance(buckets: BillingBucketsRow): number {
  return buckets.cashMinor
    + buckets.promotionalMinor
    - buckets.reservedWithdrawalMinor
    - buckets.debtMinor;
}

export async function applyBillingCredit(
  db: TransactionalQueryable,
  input: {
    accountId: string;
    amountMinor: number;
    kind: "cash" | "promotional";
    sourceType: string;
    sourceId: string;
    description: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error("billing credit amount must be a positive integer");
  }
  await db.transaction(async (client) => {
    const buckets = await readBillingBuckets(client, input.accountId, true);
    const inserted = await insertLedgerEntry(client, {
      accountId: input.accountId,
      entryType: input.kind === "cash" ? "topup" : "manual_credit",
      amountMinor: input.amountMinor,
      currency: "USD",
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      description: input.description,
      metadata: { creditKind: input.kind, ...(input.metadata ?? {}) }
    });
    if (inserted) {
      await writeBillingBuckets(client, input.accountId, applyBucketCredit(buckets, input.amountMinor, input.kind));
    }
  });
}

export async function settleRetailBilling(
  db: TransactionalQueryable,
  config: RetailBillingRuntimeConfig,
  now = new Date()
): Promise<RetailBillingSettlementResult> {
  const lagSeconds = Math.max(60, Math.trunc(config.settlementLagSeconds));
  const cutoff = new Date(now.getTime() - lagSeconds * 1000).toISOString();
  const candidates = await listRetailRatingCandidates(db, cutoff, config.batchSize ?? 250);
  const result: RetailBillingSettlementResult = {
    mode: config.mode,
    ratedWindows: 0,
    postedMinor: 0,
    graceStarted: 0,
    suspended: 0,
    restored: 0
  };
  const touchedAccounts = new Set<string>();

  for (const candidate of candidates) {
    const posted = await settleRatingCandidate(db, candidate, config.mode);
    if (posted !== null) {
      result.ratedWindows += 1;
      result.postedMinor += posted;
      touchedAccounts.add(candidate.accountId);
    }
  }

  if (config.mode === "enforce") {
    for (const accountId of await listBillingAccountsNeedingStateCheck(db, config.batchSize ?? 250)) {
      touchedAccounts.add(accountId);
    }
    for (const accountId of touchedAccounts) {
      const transition = await reconcileBillingAccountState(db, accountId, now);
      if (transition === "grace_started") result.graceStarted += 1;
      if (transition === "suspended") result.suspended += 1;
      if (transition === "restored") result.restored += 1;
    }
  }
  return result;
}

async function settleRatingCandidate(
  db: TransactionalQueryable,
  candidate: RetailRatingCandidateRow,
  mode: "shadow" | "enforce"
): Promise<number | null> {
  const bytesToDestination = BigInt(candidate.bytesToDestination);
  const bytesFromDestination = BigInt(candidate.bytesFromDestination);
  const chargeMicrominor = calculateRetailChargeMicrominor({
    activeSeconds: candidate.activeSeconds,
    activeConfigMonthlyMinor: candidate.activeConfigMonthlyMinor,
    bytesToDestination,
    bytesFromDestination,
    trafficPerGbMinor: candidate.trafficPerGbMinor
  });

  return db.transaction(async (client) => {
    const rating = await insertRetailUsageRating(client, {
      accountId: candidate.accountId,
      sessionId: candidate.sessionId,
      planVersionId: candidate.planVersionId,
      windowStart: candidate.windowStart,
      windowEnd: candidate.windowEnd,
      activeSeconds: candidate.activeSeconds,
      bytesToDestination,
      bytesFromDestination,
      chargeMicrominor,
      mode,
      metadata: {
        sessionLabel: candidate.sessionLabel,
        planCode: candidate.planCode,
        planVersion: candidate.planVersion,
        byteDefinition: "egress accepted payload in both directions"
      }
    });
    if (!rating) {
      return null;
    }
    if (mode === "shadow") {
      return 0;
    }

    const previousRemainder = await lockBillingAccrual(client, candidate.accountId);
    const accumulated = previousRemainder + chargeMicrominor;
    const postedMinor = Number(accumulated / MICROMINOR_PER_MINOR);
    await updateBillingAccrual(client, candidate.accountId, accumulated % MICROMINOR_PER_MINOR);
    if (postedMinor <= 0) {
      return 0;
    }

    const buckets = await readBillingBuckets(client, candidate.accountId, true);
    const inserted = await insertLedgerEntry(client, {
      accountId: candidate.accountId,
      entryType: "usage_charge",
      amountMinor: -postedMinor,
      currency: "USD",
      sourceType: "retail_usage_rating",
      sourceId: rating.id,
      description: candidate.sessionLabel
        ? `VPN usage: ${candidate.sessionLabel}`
        : `VPN usage: ${candidate.sessionId}`,
      metadata: {
        sessionId: candidate.sessionId,
        windowStart: candidate.windowStart,
        windowEnd: candidate.windowEnd,
        activeSeconds: candidate.activeSeconds,
        bytesToDestination: bytesToDestination.toString(),
        bytesFromDestination: bytesFromDestination.toString(),
        planCode: candidate.planCode,
        planVersion: candidate.planVersion
      }
    });
    if (!inserted) {
      return 0;
    }
    await writeBillingBuckets(client, candidate.accountId, consumeBillingCharge(buckets, postedMinor));
    await markRatingPosted(client, rating.id, postedMinor);
    return postedMinor;
  });
}

async function reconcileBillingAccountState(
  db: TransactionalQueryable,
  accountId: string,
  now: Date
): Promise<"unchanged" | "grace_started" | "suspended" | "restored"> {
  return db.transaction(async (client) => {
    const [state, buckets, plan] = await Promise.all([
      readBillingAccountState(client, accountId, true),
      readBillingBuckets(client, accountId, true),
      readCurrentBillingPlan(client, accountId)
    ]);
    const nowIso = now.toISOString();
    const balance = availableBillingBalance(buckets);

    if (balance >= 0) {
      const changed = state.state !== "active";
      await updateBillingAccountState(client, accountId, {
        state: "active",
        overdrawnAt: null,
        suspensionDueAt: null,
        suspendedAt: null,
        withdrawalEligibleAt: state.withdrawalEligibleAt,
        settledAt: nowIso
      });
      if (changed) {
        await enqueueBillingNotification(client, {
          accountId,
          notificationType: "billing_balance_restored",
          dedupeKey: `billing-restored:${accountId}:${nowIso}`,
          payload: { balanceMinor: balance }
        });
      }
      return changed ? "restored" : "unchanged";
    }

    if (state.state === "active") {
      const dueAt = new Date(now.getTime() + plan.gracePeriodSeconds * 1000).toISOString();
      const sessions = await listNonTerminalAccountSessions(client, accountId);
      await updateBillingAccountState(client, accountId, {
        state: "grace",
        overdrawnAt: nowIso,
        suspensionDueAt: dueAt,
        suspendedAt: null,
        withdrawalEligibleAt: null,
        settledAt: nowIso
      });
      await enqueueBillingNotification(client, {
        accountId,
        notificationType: "billing_grace_started",
        dedupeKey: `billing-grace:${accountId}:${nowIso}`,
        payload: {
          balanceMinor: balance,
          suspensionDueAt: dueAt,
          configs: sessions.map((session) => ({ id: session.id, label: session.label }))
        }
      });
      return "grace_started";
    }

    if (state.state === "grace" && state.suspensionDueAt && Date.parse(state.suspensionDueAt) <= now.getTime()) {
      const sessions = await listNonTerminalAccountSessions(client, accountId);
      for (const session of sessions) {
        await requestSystemSessionRevocation(client, session.id, {
          reason: "billing_balance_exhausted",
          accountId,
          balanceMinor: balance,
          suspensionDueAt: state.suspensionDueAt
        });
      }
      const withdrawalEligibleAt = new Date(now.getTime() + plan.withdrawalCooldownSeconds * 1000).toISOString();
      await updateBillingAccountState(client, accountId, {
        state: "suspended",
        overdrawnAt: state.overdrawnAt,
        suspensionDueAt: state.suspensionDueAt,
        suspendedAt: nowIso,
        withdrawalEligibleAt,
        settledAt: nowIso
      });
      await enqueueBillingNotification(client, {
        accountId,
        notificationType: "billing_configs_suspended",
        dedupeKey: `billing-suspended:${accountId}:${nowIso}`,
        payload: {
          balanceMinor: balance,
          withdrawalEligibleAt,
          configs: sessions.map((session) => ({ id: session.id, label: session.label }))
        }
      });
      return "suspended";
    }

    await updateBillingAccountState(client, accountId, {
      state: state.state,
      overdrawnAt: state.overdrawnAt,
      suspensionDueAt: state.suspensionDueAt,
      suspendedAt: state.suspendedAt,
      withdrawalEligibleAt: state.withdrawalEligibleAt,
      settledAt: nowIso
    });
    return "unchanged";
  });
}

function nonNegative(value: bigint): bigint {
  return value < 0n ? 0n : value;
}
