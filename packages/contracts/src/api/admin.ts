import type { FromSchema } from "json-schema-to-ts";
import { conditionSchema } from "../resources/condition.js";
import { gateAssignmentSchema } from "../resources/gate-assignment.js";
import { gateAgentDeploymentSchema, gateAgentReleaseSchema } from "../resources/gate-agent-deployment.js";
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

export const adminCreateGateAgentReleaseRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "revision", "builtAt", "artifactSha256"],
  properties: {
    version: { type: "string", minLength: 1 },
    revision: { type: "string", pattern: "^[a-f0-9]{40}$" },
    builtAt: { type: "string", format: "date-time" },
    artifactSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }
  }
} as const;

export const adminGateAgentReleaseResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["release"],
  properties: { release: gateAgentReleaseSchema }
} as const;

export const adminGateAgentReleasesResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["releases"],
  properties: { releases: { type: "array", items: gateAgentReleaseSchema } }
} as const;

export const adminRequestGateAgentDeploymentRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["releaseId"],
  properties: { releaseId: { type: "string", format: "uuid" } }
} as const;

export const adminGateAgentDeploymentResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["deployment"],
  properties: { deployment: gateAgentDeploymentSchema }
} as const;

export const adminGateAgentDeploymentsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["deployments"],
  properties: { deployments: { type: "array", items: gateAgentDeploymentSchema } }
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

export const adminDoubleZeroUsageImportRecordSchema = {
  type: "object",
  additionalProperties: true,
  required: ["recordId", "windowStart", "windowEnd", "doubleZeroCostMinor"],
  properties: {
    recordId: { type: "string", minLength: 1 },
    accountId: { type: "string", minLength: 1 },
    sessionId: { type: "string", minLength: 1 },
    windowStart: { type: "string", format: "date-time" },
    windowEnd: { type: "string", format: "date-time" },
    ingressGateName: { type: "string" },
    egressGateName: { type: "string" },
    bytesIn: { type: "number", minimum: 0 },
    bytesOut: { type: "number", minimum: 0 },
    doubleZeroCostMinor: { type: "number", minimum: 0 },
    currency: { type: "string" },
    metadata: { type: "object", additionalProperties: true }
  }
} as const;

export const adminDoubleZeroUsageImportRequestSchema = {
  type: "object",
  additionalProperties: true,
  required: ["cluster", "tenant", "importSource", "raw", "records"],
  properties: {
    cluster: { type: "string", minLength: 1 },
    tenant: { type: "string", minLength: 1 },
    importSource: { type: "string", minLength: 1 },
    raw: { type: "object", additionalProperties: true },
    records: {
      type: "array",
      minItems: 1,
      items: adminDoubleZeroUsageImportRecordSchema
    }
  }
} as const;

export const adminDoubleZeroUsageImportResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["importId", "imported", "duplicates", "rejected", "totalChargeMinor", "currency"],
  properties: {
    importId: { type: "string" },
    imported: { type: "number" },
    duplicates: { type: "number" },
    rejected: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["recordId", "reason"],
        properties: {
          recordId: { type: "string" },
          reason: { type: "string" }
        }
      }
    },
    totalChargeMinor: { type: "number" },
    currency: { type: "string" }
  }
} as const;
