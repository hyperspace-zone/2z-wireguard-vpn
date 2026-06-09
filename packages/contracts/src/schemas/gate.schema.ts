import {
  gateActualStateRequestSchema,
  gateHeartbeatRequestSchema,
  gateJobClaimResponseSchema,
  gateJobReportRequestSchema
} from "../api/gate.js";

export const gateApiSchemas = {
  heartbeatRequest: gateHeartbeatRequestSchema,
  actualStateRequest: gateActualStateRequestSchema,
  jobClaimResponse: gateJobClaimResponseSchema,
  jobReportRequest: gateJobReportRequestSchema
} as const;
