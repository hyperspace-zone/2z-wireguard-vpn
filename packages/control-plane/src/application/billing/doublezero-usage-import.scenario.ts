import type { TransactionalQueryable } from "../../db/queryable.js";
import {
  ensureBillingAccount,
  findAccountId,
  findAccountIdForSession,
  insertDoubleZeroUsageImport,
  insertLedgerEntry,
  insertRatedUsageEvent
} from "../../resources/billing/repository.js";

export interface DoubleZeroUsageBillingConfig {
  currency: string;
  usageMarkupBps: number;
}

export interface DoubleZeroUsageRecordInput {
  recordId: string;
  accountId?: string;
  sessionId?: string;
  windowStart: string;
  windowEnd: string;
  ingressGateName?: string;
  egressGateName?: string;
  bytesIn?: number;
  bytesOut?: number;
  doubleZeroCostMinor: number;
  currency?: string;
  metadata?: Record<string, unknown>;
}

export interface DoubleZeroUsageImportInput {
  cluster: string;
  tenant: string;
  importSource: string;
  raw: Record<string, unknown>;
  records: DoubleZeroUsageRecordInput[];
}

export interface DoubleZeroUsageImportResult {
  importId: string;
  imported: number;
  duplicates: number;
  rejected: Array<{ recordId: string; reason: string }>;
  totalChargeMinor: number;
  currency: string;
}

export async function importDoubleZeroUsage(
  db: TransactionalQueryable,
  input: DoubleZeroUsageImportInput,
  config: DoubleZeroUsageBillingConfig
): Promise<DoubleZeroUsageImportResult> {
  const markupBps = normalizeMarkupBps(config.usageMarkupBps);
  const currency = config.currency;

  return db.transaction(async (client) => {
    const importId = await insertDoubleZeroUsageImport(client, {
      cluster: input.cluster,
      tenant: input.tenant,
      importSource: input.importSource,
      raw: input.raw
    });

    let imported = 0;
    let duplicates = 0;
    let totalChargeMinor = 0;
    const rejected: DoubleZeroUsageImportResult["rejected"] = [];

    for (const record of input.records) {
      const recordId = record.recordId.trim();
      if (!recordId) {
        rejected.push({ recordId: "", reason: "missing_record_id" });
        continue;
      }
      if (!Number.isInteger(record.doubleZeroCostMinor) || record.doubleZeroCostMinor < 0) {
        rejected.push({ recordId, reason: "invalid_doublezero_cost_minor" });
        continue;
      }
      const accountId = record.accountId
        ? await findAccountId(client, record.accountId)
        : (record.sessionId ? await findAccountIdForSession(client, record.sessionId) : null);
      if (!accountId) {
        rejected.push({ recordId, reason: "account_not_found" });
        continue;
      }
      const recordCurrency = record.currency ?? currency;
      if (recordCurrency !== currency) {
        rejected.push({ recordId, reason: "currency_mismatch" });
        continue;
      }

      await ensureBillingAccount(client, accountId, currency);
      const chargeMinor = calculateMarkedUpChargeMinor(record.doubleZeroCostMinor, markupBps);
      const ratedInput = {
        accountId,
        provider: "doublezero",
        sourceType: "doublezero_usage_record",
        sourceId: recordId,
        windowStart: record.windowStart,
        windowEnd: record.windowEnd,
        bytesIn: nonNegativeInteger(record.bytesIn),
        bytesOut: nonNegativeInteger(record.bytesOut),
        costMinor: record.doubleZeroCostMinor,
        markupBps,
        chargeMinor,
        currency,
        metadata: {
          tenant: input.tenant,
          cluster: input.cluster,
          importId,
          ...(record.metadata ?? {})
        }
      };
      const rated = await insertRatedUsageEvent(client, {
        ...ratedInput,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        ...(record.ingressGateName ? { ingressGateName: record.ingressGateName } : {}),
        ...(record.egressGateName ? { egressGateName: record.egressGateName } : {})
      });
      if (!rated) {
        duplicates += 1;
        continue;
      }

      await insertLedgerEntry(client, {
        accountId,
        entryType: "usage",
        amountMinor: -chargeMinor,
        currency,
        sourceType: "rated_usage_event",
        sourceId: rated.id,
        description: "DoubleZero usage charge",
        metadata: {
          provider: "doublezero",
          sourceRecordId: recordId,
          doubleZeroCostMinor: record.doubleZeroCostMinor,
          markupBps
        }
      });
      imported += 1;
      totalChargeMinor += chargeMinor;
    }

    return {
      importId,
      imported,
      duplicates,
      rejected,
      totalChargeMinor,
      currency
    };
  });
}

export function calculateMarkedUpChargeMinor(costMinor: number, markupBps: number): number {
  if (!Number.isInteger(costMinor) || costMinor < 0) {
    throw new Error("costMinor must be a non-negative integer");
  }
  const normalizedMarkupBps = normalizeMarkupBps(markupBps);
  return Math.ceil((costMinor * (10_000 + normalizedMarkupBps)) / 10_000);
}

function normalizeMarkupBps(markupBps: number): number {
  if (!Number.isInteger(markupBps) || markupBps < 0 || markupBps > 100_000) {
    return 0;
  }
  return markupBps;
}

function nonNegativeInteger(value: number | undefined): number {
  return Number.isInteger(value) && value !== undefined && value >= 0 ? value : 0;
}
