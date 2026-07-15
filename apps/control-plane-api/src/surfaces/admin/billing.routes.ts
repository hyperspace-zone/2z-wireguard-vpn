import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import {
  adminDoubleZeroBillingSnapshotRequestSchema,
  adminDoubleZeroBillingSnapshotResponseSchema,
  adminDoubleZeroUsageImportRequestSchema,
  adminDoubleZeroUsageImportResponseSchema,
  errorResponseSchema
} from "@hyperspace-zone/contracts";
import {
  applyBillingCredit,
  assignBillingPlan,
  createBillingPlanVersion,
  importDoubleZeroUsage,
  insertDoubleZeroTenantBillingSnapshot,
  insertDoubleZeroTenantCostEvent,
  listAdminBillingConfigs,
  listBillingCustomers,
  listBillingPlans,
  type BillingConfig
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { AdminAuthContext } from "../../http/auth.js";
import { asRecord, readString } from "../../http/request.js";

export function registerAdminBillingRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<AdminAuthContext | null>;
    billing: BillingConfig;
  }
): void {
  app.get("/v1/admin/billing/customers", async (request, reply) => {
    const admin = await deps.requireAdmin(request, reply);
    if (!admin) return;
    const [customers, plans, configs] = await Promise.all([
      listBillingCustomers(deps.db), listBillingPlans(deps.db), listAdminBillingConfigs(deps.db)
    ]);
    return reply.send({ customers, plans, configs });
  });

  app.post("/v1/admin/billing/customers/:accountId/credits", async (request, reply) => {
    const admin = await deps.requireAdmin(request, reply);
    if (!admin) return;
    const body = asRecord(request.body);
    const amountMinor = readNumber(body, "amountMinor") ?? 0;
    const reason = readString(body, "reason");
    const accountId = readPathParam(request, "accountId");
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !reason) {
      return reply.code(400).send({ error: "invalid_manual_credit", message: "Positive amountMinor and reason are required." });
    }
    const creditId = randomUUID();
    await applyBillingCredit(deps.db, {
      accountId,
      amountMinor,
      kind: "promotional",
      sourceType: "admin_manual_credit",
      sourceId: creditId,
      description: reason,
      metadata: { adminId: admin.id }
    });
    await deps.db.query(
      `INSERT INTO audit_events (event_type, actor_type, actor_id, account_id, details)
       VALUES ('billing_manual_credit_added', 'admin', $1, $2, $3::jsonb)`,
      [admin.id, accountId, JSON.stringify({ creditId, amountMinor, reason, withdrawable: false })]
    );
    return reply.code(201).send({ creditId });
  });

  app.post("/v1/admin/billing/customers/:accountId/plan", async (request, reply) => {
    const admin = await deps.requireAdmin(request, reply);
    if (!admin) return;
    const body = asRecord(request.body);
    const accountId = readPathParam(request, "accountId");
    await deps.db.transaction(async (client) => {
      await assignBillingPlan(client, {
        accountId,
        planCode: readString(body, "code"),
        planVersion: readNumber(body, "version") ?? 0,
        assignedBy: admin.id,
        reason: readString(body, "reason") || "Admin plan assignment"
      });
      await client.query(
        `INSERT INTO audit_events (event_type, actor_type, actor_id, account_id, details)
         VALUES ('billing_plan_assigned', 'admin', $1, $2, $3::jsonb)`,
        [admin.id, accountId, JSON.stringify(body)]
      );
    });
    return reply.send({ status: "assigned" });
  });

  app.post("/v1/admin/billing/plans", async (request, reply) => {
    const admin = await deps.requireAdmin(request, reply);
    if (!admin) return;
    const body = asRecord(request.body);
    const plan = await createBillingPlanVersion(deps.db, {
      code: readString(body, "code"),
      version: readNumber(body, "version") ?? 0,
      displayName: readString(body, "displayName"),
      activeConfigMonthlyMinor: readNumber(body, "activeConfigMonthlyMinor") ?? 0,
      trafficPerGbMinor: readNumber(body, "trafficPerGbMinor") ?? 0,
      gracePeriodSeconds: readNumber(body, "gracePeriodSeconds") ?? 86400,
      withdrawalCooldownSeconds: readNumber(body, "withdrawalCooldownSeconds") ?? 86400,
      minimumWithdrawalMinor: readNumber(body, "minimumWithdrawalMinor") ?? 100,
      createdBy: admin.id
    });
    return reply.code(201).send({ plan });
  });

  app.post("/v1/admin/billing/doublezero/cost-events", async (request, reply) => {
    const admin = await deps.requireAdmin(request, reply);
    if (!admin) return;
    const body = asRecord(request.body);
    const amount = readString(body, "amountBaseUnits");
    const usdCostMinor = readNumber(body, "usdCostMinor");
    if (!/^\d+$/.test(amount)) return reply.code(400).send({ error: "invalid_amount", message: "amountBaseUnits must be an integer string" });
    const event = await insertDoubleZeroTenantCostEvent(deps.db, {
      cluster: readString(body, "cluster"),
      tenant: readString(body, "tenant"),
      dzEpoch: readNumber(body, "dzEpoch") ?? -1,
      tokenSymbol: readString(body, "tokenSymbol") || "2Z",
      tokenMint: readString(body, "tokenMint"),
      amountBaseUnits: BigInt(amount),
      ...(usdCostMinor !== undefined ? { usdCostMinor } : {}),
      quote: asRecord(body.quote)
    });
    return reply.code(201).send(event);
  });

  app.post("/v1/admin/billing/doublezero/tenant-snapshots", {
    schema: {
      body: adminDoubleZeroBillingSnapshotRequestSchema,
      response: {
        201: adminDoubleZeroBillingSnapshotResponseSchema,
        403: errorResponseSchema
      }
    }
  }, async (request, reply) => {
    const admin = await deps.requireAdmin(request, reply);
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
    const admin = await deps.requireAdmin(request, reply);
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

function readPathParam(request: FastifyRequest, key: string): string {
  const params = request.params as Record<string, unknown>;
  return typeof params[key] === "string" ? params[key] : "";
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
