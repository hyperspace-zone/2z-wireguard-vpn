import type { FromSchema } from "json-schema-to-ts";

export const gateDesiredStateValues = ["Enabled", "Draining", "Disabled", "Maintenance"] as const;

export type GateDesiredState = typeof gateDesiredStateValues[number];

export const gateDoubleZeroStatusSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    tunnelStatus: { type: "string" },
    lastSessionUpdate: { type: "string" },
    tunnelName: { type: "string" },
    tunnelSrc: { type: "string" },
    tunnelDst: { type: "string" },
    doubleZeroIp: { type: "string" },
    userType: { type: "string" },
    reconciler: { type: "string" },
    tenant: { type: "string" },
    currentDevice: { type: "string" },
    lowestLatencyDevice: { type: "string" },
    lowestLatencyDeviceWarning: { type: "boolean" },
    metro: { type: "string" },
    network: { type: "string" },
    edgeRttMs: { type: "number" },
    edgeRttTarget: { type: "string" },
    edgeRttInterface: { type: "string" },
    edgeRttMeasuredAt: { type: "string", format: "date-time" },
    edgeRttError: { type: "string" },
    reportedAt: { type: "string", format: "date-time" },
    error: { type: "string" },
    raw: { type: "string" }
  }
} as const;

export type GateDoubleZeroStatus = FromSchema<typeof gateDoubleZeroStatusSchema>;

export const gateSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "desiredState", "publicIpv4", "ready", "schedulable"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    desiredState: { enum: gateDesiredStateValues },
    city: { type: "string" },
    country: { type: "string" },
    publicIpv4: { type: "string" },
    probeUrl: { type: "string" },
    lastSeenAt: { type: "string", format: "date-time" },
    doubleZero: gateDoubleZeroStatusSchema,
    ready: { type: "boolean" },
    schedulable: { type: "boolean" }
  }
} as const;

export type GateSummary = FromSchema<typeof gateSummarySchema>;
