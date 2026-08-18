import type { FromSchema } from "json-schema-to-ts";
import { gateBenchmarkRouteSchema } from "../resources/benchmark.js";
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
  required: ["id", "accountId", "email", "displayName", "avatarUrl"],
  properties: {
    id: { type: "string" },
    accountId: { type: "string" },
    email: { type: "string" },
    displayName: { type: "string" },
    avatarUrl: { type: ["string", "null"] }
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

export const publicAuthMeResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["user", "capabilities"],
  properties: {
    user: publicUserSchema,
    capabilities: {
      type: "array",
      items: { enum: ["billing:admin"] },
      uniqueItems: true
    }
  }
} as const;

export const publicRequestEmailLoginCodeRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["email"],
  properties: {
    email: { type: "string", format: "email" }
  }
} as const;

export const publicRequestEmailLoginCodeResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "email", "expiresAt"],
  properties: {
    status: { const: "sent" },
    email: { type: "string" },
    expiresAt: { type: "string", format: "date-time" },
    devCode: { type: "string" }
  }
} as const;

export const publicVerifyEmailLoginCodeRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "code"],
  properties: {
    email: { type: "string", format: "email" },
    code: { type: "string", minLength: 6, maxLength: 6 }
  }
} as const;

export const publicGoogleOAuthStartResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["authorizationUrl", "expiresAt"],
  properties: {
    authorizationUrl: { type: "string" },
    expiresAt: { type: "string", format: "date-time" }
  }
} as const;

export const publicBillingLedgerEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "entryType", "amountMinor", "currency", "sourceType", "sourceId", "description", "createdAt"],
  properties: {
    id: { type: "string" },
    entryType: { type: "string" },
    amountMinor: { type: "number" },
    currency: { type: "string" },
    sourceType: { type: "string" },
    sourceId: { type: "string" },
    description: { type: "string" },
    createdAt: { type: "string", format: "date-time" }
  }
} as const;

export const publicBillingDepositDestinationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["chain", "address", "tokenSymbol", "tokenMint", "tokenDecimals", "qrSvg"],
  properties: {
    chain: { const: "solana" },
    address: { type: "string" },
    tokenSymbol: { type: "string" },
    tokenMint: { type: "string" },
    tokenDecimals: { type: "number" },
    qrSvg: { type: "string" }
  }
} as const;

export const publicBillingDepositSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "transactionSignature", "chain", "status", "tokenSymbol", "tokenMint",
    "tokenAmountBaseUnits", "tokenDecimals", "creditedAmountMinor", "currency",
    "observedAt", "explorerUrl"
  ],
  properties: {
    transactionSignature: { type: "string" },
    chain: { const: "solana" },
    status: { const: "finalized" },
    tokenSymbol: { type: "string" },
    tokenMint: { type: "string" },
    tokenAmountBaseUnits: { type: "string" },
    tokenDecimals: { type: "number" },
    creditedAmountMinor: { type: "number" },
    currency: { type: "string" },
    observedAt: { type: "string", format: "date-time" },
    explorerUrl: { type: "string" }
  }
} as const;

export const publicBillingSummaryResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["accountId", "balanceMinor", "currency", "ledger", "deposit", "deposits", "buckets", "state", "plan", "availableBalanceMinor", "withdrawableBalanceMinor", "usage", "withdrawals", "walletBalanceBaseUnits", "walletSpendableBaseUnits", "walletRentReserveBaseUnits", "configPriceBaseUnits"],
  properties: {
    accountId: { type: "string" },
    balanceMinor: { type: "number" },
    currency: { type: "string" },
    ledger: { type: "array", items: publicBillingLedgerEntrySchema },
    deposit: { anyOf: [publicBillingDepositDestinationSchema, { type: "null" }] },
    deposits: { type: "array", items: publicBillingDepositSchema },
    availableBalanceMinor: { type: "number" },
    withdrawableBalanceMinor: { type: "number" },
    buckets: {
      type: "object",
      additionalProperties: false,
      required: ["cashMinor", "promotionalMinor", "reservedWithdrawalMinor", "debtMinor"],
      properties: {
        cashMinor: { type: "number" },
        promotionalMinor: { type: "number" },
        reservedWithdrawalMinor: { type: "number" },
        debtMinor: { type: "number" }
      }
    },
    state: {
      type: "object",
      additionalProperties: false,
      required: ["state", "overdrawnAt", "suspensionDueAt", "suspendedAt", "withdrawalEligibleAt", "lastSettledAt"],
      properties: {
        state: { type: "string" },
        overdrawnAt: { type: ["string", "null"], format: "date-time" },
        suspensionDueAt: { type: ["string", "null"], format: "date-time" },
        suspendedAt: { type: ["string", "null"], format: "date-time" },
        withdrawalEligibleAt: { type: ["string", "null"], format: "date-time" },
        lastSettledAt: { type: ["string", "null"], format: "date-time" }
      }
    },
    plan: {
      type: "object",
      additionalProperties: false,
      required: ["id", "code", "version", "displayName", "currency", "activeConfigMonthlyMinor", "trafficPerGbMinor", "gracePeriodSeconds", "withdrawalCooldownSeconds", "minimumWithdrawalMinor"],
      properties: {
        id: { type: "string" }, code: { type: "string" }, version: { type: "number" }, displayName: { type: "string" }, currency: { type: "string" },
        activeConfigMonthlyMinor: { type: "number" }, trafficPerGbMinor: { type: "number" }, gracePeriodSeconds: { type: "number" },
        withdrawalCooldownSeconds: { type: "number" }, minimumWithdrawalMinor: { type: "number" }
      }
    },
    usage: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["sessionId", "sessionLabel", "activeSeconds", "bytesToDestination", "bytesFromDestination", "chargeMinor", "estimatedChargeMicrominor", "lastRatedAt"],
        properties: {
          sessionId: { type: "string" }, sessionLabel: { type: ["string", "null"] }, activeSeconds: { type: "number" },
          bytesToDestination: { type: "string" }, bytesFromDestination: { type: "string" }, chargeMinor: { type: "number" },
          estimatedChargeMicrominor: { type: "string" }, lastRatedAt: { type: "string", format: "date-time" }
        }
      }
    },
    withdrawals: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "status", "amountMinor", "currency", "tokenSymbol", "tokenMint", "tokenAmountBaseUnits", "destinationAddress", "eligibleAt", "transactionSignature", "failureReason", "requestedAt", "submittedAt", "confirmedAt"],
        properties: {
          id: { type: "string" }, status: { type: "string" }, amountMinor: { type: "number" }, currency: { type: "string" },
          tokenSymbol: { type: "string" }, tokenMint: { type: "string" }, tokenAmountBaseUnits: { type: "string" }, destinationAddress: { type: "string" },
          eligibleAt: { type: "string", format: "date-time" }, transactionSignature: { type: ["string", "null"] }, failureReason: { type: ["string", "null"] },
          requestedAt: { type: "string", format: "date-time" }, submittedAt: { type: ["string", "null"], format: "date-time" }, confirmedAt: { type: ["string", "null"], format: "date-time" }
        }
      }
    },
    walletBalanceBaseUnits: { type: ["string", "null"] },
    walletSpendableBaseUnits: { type: ["string", "null"] },
    walletRentReserveBaseUnits: { type: ["string", "null"] },
    configPriceBaseUnits: { type: "string" }
  }
} as const;

export const publicCreateWithdrawalRequestSchema = {
  type: "object", additionalProperties: false, required: ["amountMinor", "destinationAddress"],
  properties: { amountMinor: { type: "number", minimum: 1 }, destinationAddress: { type: "string", minLength: 32 } }
} as const;

export const publicCreateSessionRequestSchema = {
  type: "object",
  additionalProperties: true,
  required: ["mode"],
  properties: {
    ...sessionSpecSchema.properties,
    label: { type: "string" },
    targetIp: { type: "string" },
    sourceIp: { type: "string" },
    paymentRequestId: { type: "string", format: "uuid" }
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

export const publicGateBenchmarkMatrixResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["generatedAt", "gates", "routes"],
  properties: {
    generatedAt: { type: "string", format: "date-time" },
    gates: { type: "array", items: gateSummarySchema },
    routes: { type: "array", items: gateBenchmarkRouteSchema }
  }
} as const;

export type PublicGateBenchmarkMatrixResponse = FromSchema<typeof publicGateBenchmarkMatrixResponseSchema>;

export const publicNetworkMeResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ip"],
  properties: {
    ip: { type: "string" }
  }
} as const;

export const publicArtifactDownloadTokenResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["token", "expiresAt", "downloadUrl", "downloadConfigUrl"],
  properties: {
    token: { type: "string" },
    expiresAt: { type: "string", format: "date-time" },
    downloadUrl: { type: "string" },
    downloadConfigUrl: { type: "string" }
  }
} as const;

export const publicArtifactDownloadResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["artifactId", "metadata", "payload", "encryptedPayloadRef"],
  properties: {
    artifactId: { type: "string" },
    metadata: {},
    payload: { type: "object", additionalProperties: true },
    payloadType: { type: "string" },
    encryptedPayloadRef: { type: ["string", "null"] }
  }
} as const;

export const publicRawWireGuardConfigResponseSchema = {
  type: "string"
} as const;
