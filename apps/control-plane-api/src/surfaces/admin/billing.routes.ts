import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  adminDoubleZeroBillingSnapshotRequestSchema,
  adminDoubleZeroBillingSnapshotResponseSchema,
  adminDoubleZeroUsageImportRequestSchema,
  adminDoubleZeroUsageImportResponseSchema,
  errorResponseSchema
} from "@hyperspace-zone/contracts";
import { importDoubleZeroUsage, insertDoubleZeroTenantBillingSnapshot, type BillingConfig } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { AdminAuthContext } from "../../http/auth.js";
import { asRecord, readString } from "../../http/request.js";

export function registerAdminBillingRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => AdminAuthContext | null;
    billing: BillingConfig;
  }
): void {
  app.post("/v1/admin/billing/doublezero/tenant-snapshots", {
    schema: {
      body: adminDoubleZeroBillingSnapshotRequestSchema,
      response: {
        201: adminDoubleZeroBillingSnapshotResponseSchema,
        403: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const admin = deps.requireAdmin(request, reply);
    if (!admin) {
      return;
    }
    const body = asRecord(request.body);
    const paymentStatus = readString(body, "paymentStatus");
    const tokenAccount = readString(body, "tokenAccount");
    const billingRate = readString(body, "billingRate");
    const lastDeductionDzEpoch = readNumber(body, "lastDeductionDzEpoch");
    const id = await insertDoubleZeroTenantBillingSnapshot(deps.db, {
      cluster: readString(body, "cluster"),
      tenant: readString(body, "tenant"),
      ...(paymentStatus ? { paymentStatus } : {}),
      ...(tokenAccount ? { tokenAccount } : {}),
      ...(billingRate ? { billingRate } : {}),
      ...(lastDeductionDzEpoch !== undefined ? { lastDeductionDzEpoch } : {}),
      raw: asRecord(body.raw)
    });
    return reply.code(201).send({ id });
  });

  app.post("/v1/admin/billing/doublezero/usage-imports", {
    schema: {
      body: adminDoubleZeroUsageImportRequestSchema,
      response: {
        202: adminDoubleZeroUsageImportResponseSchema,
        403: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const admin = deps.requireAdmin(request, reply);
    if (!admin) {
      return;
    }
    const body = asRecord(request.body);
    const result = await importDoubleZeroUsage(deps.db, {
      cluster: readString(body, "cluster"),
      tenant: readString(body, "tenant"),
      importSource: readString(body, "importSource"),
      raw: asRecord(body.raw),
      records: readRecords(body.records)
    }, deps.billing);
    return reply.code(202).send(result);
  });
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readRecords(value: unknown): Array<{
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
}> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => {
    const record = asRecord(item);
    const accountId = readString(record, "accountId");
    const sessionId = readString(record, "sessionId");
    const ingressGateName = readString(record, "ingressGateName");
    const egressGateName = readString(record, "egressGateName");
    const currency = readString(record, "currency");
    const bytesIn = readNumber(record, "bytesIn");
    const bytesOut = readNumber(record, "bytesOut");
    const metadataValue = record.metadata;
    return {
      recordId: readString(record, "recordId"),
      ...(accountId ? { accountId } : {}),
      ...(sessionId ? { sessionId } : {}),
      windowStart: readString(record, "windowStart"),
      windowEnd: readString(record, "windowEnd"),
      ...(ingressGateName ? { ingressGateName } : {}),
      ...(egressGateName ? { egressGateName } : {}),
      ...(bytesIn !== undefined ? { bytesIn } : {}),
      ...(bytesOut !== undefined ? { bytesOut } : {}),
      doubleZeroCostMinor: readNumber(record, "doubleZeroCostMinor") ?? -1,
      ...(currency ? { currency } : {}),
      ...(metadataValue && typeof metadataValue === "object" && !Array.isArray(metadataValue)
        ? { metadata: asRecord(metadataValue) }
        : {})
    };
  });
}
