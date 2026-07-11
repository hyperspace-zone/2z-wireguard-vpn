import {
  importDoubleZeroUsage,
  readBillingImportCursor,
  recordBillingImportFailure,
  recordBillingImportSuccess,
  type DoubleZeroUsageRecordInput
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { ControlPlaneWorkerConfig } from "../config.js";

export interface MeteringLoopResult {
  status: "disabled" | "not-modified" | "imported";
  imported: number;
  duplicates: number;
  rejected: number;
}

export function createDoubleZeroMeteringLoop(db: Database, config: ControlPlaneWorkerConfig): {
  due(): boolean;
  runOnce(): Promise<MeteringLoopResult>;
} {
  let nextRunAt = 0;
  return {
    due(): boolean {
      return Boolean(config.doubleZeroMetering.url) && Date.now() >= nextRunAt;
    },
    async runOnce(): Promise<MeteringLoopResult> {
      if (!config.doubleZeroMetering.url) {
        return { status: "disabled", imported: 0, duplicates: 0, rejected: 0 };
      }
      nextRunAt = Date.now() + Math.max(60, config.doubleZeroMetering.intervalSeconds) * 1000;
      const sourceName = config.doubleZeroMetering.sourceName;
      const cursor = await readBillingImportCursor(db, sourceName);
      const headers: Record<string, string> = { accept: "application/json" };
      if (config.doubleZeroMetering.bearerToken) {
        headers.authorization = `Bearer ${config.doubleZeroMetering.bearerToken}`;
      }
      if (cursor?.etag) headers["if-none-match"] = cursor.etag;
      if (cursor?.lastModified) headers["if-modified-since"] = cursor.lastModified;
      try {
        const response = await fetch(config.doubleZeroMetering.url, { headers });
        if (response.status === 304) {
          await recordBillingImportSuccess(db, {
            sourceName,
            etag: cursor?.etag ?? null,
            lastModified: cursor?.lastModified ?? null
          });
          return { status: "not-modified", imported: 0, duplicates: 0, rejected: 0 };
        }
        const text = await response.text();
        const payload = text ? asRecord(JSON.parse(text)) : {};
        if (!response.ok) {
          throw new Error(`metering endpoint returned ${response.status}`);
        }
        const records = normalizeDoubleZeroUsageRecords(payload.records);
        const result = await importDoubleZeroUsage(db, {
          cluster: config.doubleZeroMetering.cluster,
          tenant: config.doubleZeroMetering.tenant,
          importSource: sourceName,
          raw: payload,
          records
        }, config.billing);
        await recordBillingImportSuccess(db, {
          sourceName,
          importId: result.importId,
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified")
        });
        return {
          status: "imported",
          imported: result.imported,
          duplicates: result.duplicates,
          rejected: result.rejected.length
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await recordBillingImportFailure(db, sourceName, message);
        throw error;
      }
    }
  };
}

export function normalizeDoubleZeroUsageRecords(value: unknown): DoubleZeroUsageRecordInput[] {
  if (!Array.isArray(value)) {
    throw new Error("metering payload must contain a records array");
  }
  return value.map((item) => {
    const record = asRecord(item);
    return {
      recordId: readString(record.recordId),
      ...(readString(record.accountId) ? { accountId: readString(record.accountId) } : {}),
      ...(readString(record.sessionId) ? { sessionId: readString(record.sessionId) } : {}),
      windowStart: readString(record.windowStart),
      windowEnd: readString(record.windowEnd),
      ...(readString(record.ingressGateName) ? { ingressGateName: readString(record.ingressGateName) } : {}),
      ...(readString(record.egressGateName) ? { egressGateName: readString(record.egressGateName) } : {}),
      bytesIn: readRequiredNonNegativeInteger(record.bytesIn),
      bytesOut: readRequiredNonNegativeInteger(record.bytesOut),
      doubleZeroCostMinor: readRequiredNonNegativeInteger(record.doubleZeroCostMinor),
      ...(readString(record.currency) ? { currency: readString(record.currency) } : {}),
      metadata: asRecord(record.metadata)
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readRequiredNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : -1;
}
