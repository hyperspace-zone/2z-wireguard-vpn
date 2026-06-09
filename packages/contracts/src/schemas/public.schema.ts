import {
  publicAuthResponseSchema,
  publicCreateSessionRequestSchema,
  publicGatesResponseSchema,
  publicLoginRequestSchema,
  publicNetworkMeResponseSchema,
  publicRegisterRequestSchema,
  publicSessionResponseSchema,
  publicSessionsResponseSchema
} from "../api/public.js";

export const publicApiSchemas = {
  registerRequest: publicRegisterRequestSchema,
  loginRequest: publicLoginRequestSchema,
  authResponse: publicAuthResponseSchema,
  createSessionRequest: publicCreateSessionRequestSchema,
  sessionResponse: publicSessionResponseSchema,
  sessionsResponse: publicSessionsResponseSchema,
  gatesResponse: publicGatesResponseSchema,
  networkMeResponse: publicNetworkMeResponseSchema
} as const;
