import {
  adminAuditEventsResponseSchema,
  adminDoubleZeroBillingSnapshotRequestSchema,
  adminDoubleZeroBillingSnapshotResponseSchema,
  adminDoubleZeroUsageImportRequestSchema,
  adminDoubleZeroUsageImportResponseSchema,
  adminForceReconcileRequestSchema,
  adminForceReconcileResponseSchema,
  adminGateCommandResponseSchema,
  adminGatesResponseSchema,
  adminJobsResponseSchema,
  adminSessionsResponseSchema
} from "../api/admin.js";

export const adminApiSchemas = {
  gatesResponse: adminGatesResponseSchema,
  sessionsResponse: adminSessionsResponseSchema,
  jobsResponse: adminJobsResponseSchema,
  auditEventsResponse: adminAuditEventsResponseSchema,
  doubleZeroBillingSnapshotRequest: adminDoubleZeroBillingSnapshotRequestSchema,
  doubleZeroBillingSnapshotResponse: adminDoubleZeroBillingSnapshotResponseSchema,
  doubleZeroUsageImportRequest: adminDoubleZeroUsageImportRequestSchema,
  doubleZeroUsageImportResponse: adminDoubleZeroUsageImportResponseSchema,
  gateCommandResponse: adminGateCommandResponseSchema,
  forceReconcileRequest: adminForceReconcileRequestSchema,
  forceReconcileResponse: adminForceReconcileResponseSchema
} as const;
