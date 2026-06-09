import {
  adminAuditEventsResponseSchema,
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
  gateCommandResponse: adminGateCommandResponseSchema,
  forceReconcileRequest: adminForceReconcileRequestSchema,
  forceReconcileResponse: adminForceReconcileResponseSchema
} as const;
