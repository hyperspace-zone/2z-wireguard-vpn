import type { FromSchema } from "json-schema-to-ts";
import { tradingLatencyPublicNodeSchema, tradingLatencyPublicTargetSchema, tradingLatencyPublicMeasurementSchema } from "./trading.js";

export const tradingPairNodeSchema = {
  ...tradingLatencyPublicNodeSchema,
  properties: {
    ...tradingLatencyPublicNodeSchema.properties,
    gateName: { type: "string" },
    schedulable: { type: "boolean" }
  }
} as const;

export const tradingPairLegSchema = {
  type: "object", additionalProperties: false,
  properties: {
    directMs: { type: "number" }, estimatedMs: { type: "number" }, savedMs: { type: "number" },
    directApiP50Ms: { type: "number" }, directApiP95Ms: { type: "number" },
    egressApiP50Ms: { type: "number" }, egressTcpMs: { type: "number" },
    sampleCount: { type: "integer" }, failureCount: { type: "integer" }
  }
} as const;

export const tradingPairRowSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "pairKey", "sourceNodeId", "venueAId", "venueBId", "status", "reason", "evidence", "legA", "legB", "configEligible"],
  properties: {
    id: { type: "string" }, pairKey: { type: "string" },
    sourceNodeId: { type: "string" }, egressNodeId: { type: "string" },
    venueAId: { type: "string" }, venueBId: { type: "string" },
    ingressGateName: { type: "string" }, egressGateName: { type: "string" },
    status: { enum: ["estimated", "no_improvement", "regression", "unavailable", "stale"] },
    evidence: { const: "estimated" }, reason: { type: "string" },
    measuredAt: { type: "string", format: "date-time" },
    backboneMeasuredAt: { type: "string", format: "date-time" },
    directIndexMs: { type: "number" }, estimatedIndexMs: { type: "number" },
    savedMs: { type: "number" }, savedPercent: { type: "number" },
    backboneRttMs: { type: "number" }, publicBackboneRttMs: { type: "number" },
    backboneSavedMs: { type: "number" }, backboneLossPercent: { type: "number" },
    legA: tradingPairLegSchema, legB: tradingPairLegSchema,
    configEligible: { type: "boolean" }
  }
} as const;

export const publicTradingPairsResponseSchema = {
  type: "object", additionalProperties: false,
  required: ["generatedAt", "methodology", "venues", "nodes", "matrix", "rows", "total", "offset", "limit", "summary"],
  properties: {
    generatedAt: { type: "string", format: "date-time" },
    snapshotStatus: { enum: ["live", "refreshing", "stale"] },
    snapshotAgeSeconds: { type: "integer", minimum: 0 },
    methodology: { const: "tcp-connect-estimate-v1" },
    venues: { type: "array", items: tradingLatencyPublicTargetSchema },
    nodes: { type: "array", items: tradingPairNodeSchema },
    matrix: { type: "array", items: tradingLatencyPublicMeasurementSchema },
    rows: { type: "array", items: tradingPairRowSchema },
    total: { type: "integer" }, offset: { type: "integer" }, limit: { type: "integer" },
    summary: {
      type: "object", additionalProperties: false, required: ["combinations", "estimatedImprovements", "verifiedRoutes", "freshNodes"],
      properties: { combinations: { type: "integer" }, estimatedImprovements: { type: "integer" }, verifiedRoutes: { const: 0 }, freshNodes: { type: "integer" } }
    }
  }
} as const;

export const publicTradingPairsQuerySchema = {
  type: "object", additionalProperties: false,
  properties: {
    a: { type: "string", maxLength: 600 }, b: { type: "string", maxLength: 600 },
    source: { type: "string", maxLength: 100 }, search: { type: "string", maxLength: 100 },
    kind: { enum: ["all", "cex-perpdex", "perpdex-perpdex", "cex-cex", "prediction"] },
    evidence: { enum: ["estimated", "measured"] },
    positive: { enum: ["true", "false"] }, noRegression: { enum: ["true", "false"] },
    group: { enum: ["best", "all"] },
    sort: { enum: ["saved", "percent", "latency", "pair"] },
    offset: { type: "integer", minimum: 0, maximum: 100000 },
    limit: { type: "integer", minimum: 1, maximum: 200 }
  }
} as const;

export const publicTradingUnavailableResponseSchema = {
  type: "object", additionalProperties: false, required: ["error", "message"],
  properties: { error: { const: "trading_snapshot_unavailable" }, message: { type: "string" } }
} as const;

export const publicTradingRouteResponseSchema = {
  type: "object", additionalProperties: false, required: ["route", "source", "egress", "venues", "warning"],
  properties: {
    route: tradingPairRowSchema, source: tradingPairNodeSchema, egress: tradingPairNodeSchema,
    venues: { type: "array", items: tradingLatencyPublicTargetSchema },
    warning: { type: "string" }
  }
} as const;

export type TradingPairRow = FromSchema<typeof tradingPairRowSchema>;
export type TradingPairNode = FromSchema<typeof tradingPairNodeSchema>;
export type TradingPairsQuery = FromSchema<typeof publicTradingPairsQuerySchema>;
export type PublicTradingPairsResponse = FromSchema<typeof publicTradingPairsResponseSchema>;
export type PublicTradingRouteResponse = FromSchema<typeof publicTradingRouteResponseSchema>;
