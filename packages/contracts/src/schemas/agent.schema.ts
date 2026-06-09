import {
  agentCreateSessionRequestSchema,
  agentSurfaceDisabledResponseSchema,
  agentTopUpEntitlementRequestSchema
} from "../api/agent.js";

export const agentApiSchemas = {
  createSessionRequest: agentCreateSessionRequestSchema,
  topUpEntitlementRequest: agentTopUpEntitlementRequestSchema,
  surfaceDisabledResponse: agentSurfaceDisabledResponseSchema
} as const;
