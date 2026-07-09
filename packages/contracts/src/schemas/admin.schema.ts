import {
  adminAuditEventsResponseSchema,
  adminDoubleZeroBillingSnapshotRequestSchema,
  adminDoubleZeroBillingSnapshotResponseSchema,
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
  gateCommandResponse: adminGateCommandResponseSchema,
  forceReconcileRequest: adminForceReconcileRequestSchema,
  forceReconcileResponse: adminForceReconcileResponseSchema
} as const;
