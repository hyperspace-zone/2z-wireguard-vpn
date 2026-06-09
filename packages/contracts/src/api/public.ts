import type { FromSchema } from "json-schema-to-ts";
import { gateSummarySchema } from "../resources/gate.js";
import { sessionSummarySchema, sessionSpecSchema } from "../resources/session.js";

export const errorResponseSchema = {
  type: "object",
  additionalProperties: true,
  required: ["error"],
  properties: {
    error: { type: "string" },
    message: { type: "string" }
  }
} as const;

export const publicRegisterRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: {
    email: { type: "string", format: "email" },
    password: { type: "string", minLength: 12 },
    displayName: { type: "string" }
  }
} as const;

export const publicLoginRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: {
    email: { type: "string", format: "email" },
    password: { type: "string", minLength: 1 }
  }
} as const;

export const publicUserSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "accountId", "email", "displayName"],
  properties: {
    id: { type: "string" },
    accountId: { type: "string" },
    email: { type: "string" },
    displayName: { type: "string" }
  }
} as const;

export type PublicUser = FromSchema<typeof publicUserSchema>;

export const publicAuthResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["user", "accessToken", "expiresAt"],
  properties: {
    user: publicUserSchema,
    accessToken: { type: "string" },
    expiresAt: { type: "string", format: "date-time" }
  }
} as const;

export const publicCreateSessionRequestSchema = {
  type: "object",
  additionalProperties: true,
  required: ["mode"],
  properties: {
    ...sessionSpecSchema.properties,
    label: { type: "string" },
    targetIp: { type: "string" },
    sourceIp: { type: "string" }
  }
} as const;

export const publicSessionResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["session"],
  properties: {
    session: sessionSummarySchema
  }
} as const;

export const publicSessionsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sessions"],
  properties: {
    sessions: { type: "array", items: sessionSummarySchema }
  }
} as const;

export const publicGatesResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["gates"],
  properties: {
    gates: { type: "array", items: gateSummarySchema }
  }
} as const;

export const publicNetworkMeResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ip"],
  properties: {
    ip: { type: "string" }
  }
} as const;
