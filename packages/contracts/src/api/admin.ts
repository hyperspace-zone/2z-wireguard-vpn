import type { FromSchema } from "json-schema-to-ts";
import { conditionSchema } from "../resources/condition.js";
import { gateAssignmentSchema } from "../resources/gate-assignment.js";
import { gateSummarySchema } from "../resources/gate.js";
import { jobSchema } from "../resources/job.js";
import { sessionSummarySchema } from "../resources/session.js";

export const adminGatesResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["gates"],
  properties: {
    gates: { type: "array", items: gateSummarySchema }
  }
} as const;

export const adminSessionInspectionSchema = {
  type: "object",
  additionalProperties: false,
  required: [...sessionSummarySchema.required, "assignments", "conditions"],
  properties: {
    ...sessionSummarySchema.properties,
    assignments: { type: "array", items: gateAssignmentSchema },
    conditions: { type: "array", items: conditionSchema }
  }
} as const;

export type AdminSessionInspection = FromSchema<typeof adminSessionInspectionSchema>;

export const adminSessionsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sessions"],
  properties: {
    sessions: { type: "array", items: adminSessionInspectionSchema }
  }
} as const;

export const adminJobsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["jobs"],
  properties: {
    jobs: { type: "array", items: jobSchema }
  }
} as const;

export const adminAuditEventsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["events"],
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["id", "eventType", "createdAt"],
        properties: {
          id: { type: "string" },
          eventType: { type: "string" },
          actorType: { type: "string" },
          actorId: { type: "string" },
          details: { type: "object", additionalProperties: true },
          createdAt: { type: "string", format: "date-time" }
        }
      }
    }
  }
} as const;

export const adminGateCommandResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string" }
  }
} as const;

export const adminForceReconcileRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    gateId: { type: "string", minLength: 1 },
    sessionId: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1 }
  }
} as const;

export const adminForceReconcileResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "jobId"],
  properties: {
    status: { const: "queued" },
    jobId: { type: "string" }
  }
} as const;

export const adminDoubleZeroBillingSnapshotRequestSchema = {
  type: "object",
  additionalProperties: true,
  required: ["cluster", "tenant", "raw"],
  properties: {
    cluster: { type: "string", minLength: 1 },
    tenant: { type: "string", minLength: 1 },
    paymentStatus: { type: "string" },
    tokenAccount: { type: "string" },
    billingRate: { type: "string" },
    lastDeductionDzEpoch: { type: "number" },
    raw: { type: "object", additionalProperties: true }
  }
} as const;

export const adminDoubleZeroBillingSnapshotResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string" }
  }
} as const;
