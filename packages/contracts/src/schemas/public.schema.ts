import {
  publicArtifactDownloadResponseSchema,
  publicArtifactDownloadTokenResponseSchema,
  publicAuthResponseSchema,
  publicAuthMeResponseSchema,
  publicCreateSessionRequestSchema,
  publicGateBenchmarkMatrixResponseSchema,
  publicGatesResponseSchema,
  publicLoginRequestSchema,
  publicNetworkMeResponseSchema,
  publicRawWireGuardConfigResponseSchema,
  publicRegisterRequestSchema,
  publicSessionResponseSchema,
  publicSessionsResponseSchema
} from "../api/public.js";

export const publicApiSchemas = {
  registerRequest: publicRegisterRequestSchema,
  loginRequest: publicLoginRequestSchema,
  authResponse: publicAuthResponseSchema,
  authMeResponse: publicAuthMeResponseSchema,
  createSessionRequest: publicCreateSessionRequestSchema,
  sessionResponse: publicSessionResponseSchema,
  sessionsResponse: publicSessionsResponseSchema,
  gatesResponse: publicGatesResponseSchema,
  gateBenchmarkMatrixResponse: publicGateBenchmarkMatrixResponseSchema,
  networkMeResponse: publicNetworkMeResponseSchema,
  artifactDownloadTokenResponse: publicArtifactDownloadTokenResponseSchema,
  artifactDownloadResponse: publicArtifactDownloadResponseSchema,
  rawWireGuardConfigResponse: publicRawWireGuardConfigResponseSchema
} as const;
