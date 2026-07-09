import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  adminDoubleZeroBillingSnapshotRequestSchema,
  adminDoubleZeroBillingSnapshotResponseSchema,
  errorResponseSchema
} from "@hyperspace-zone/contracts";
import { insertDoubleZeroTenantBillingSnapshot } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { AdminAuthContext } from "../../http/auth.js";
import { asRecord, readString } from "../../http/request.js";

export function registerAdminBillingRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => AdminAuthContext | null;
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
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
