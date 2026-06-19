import type { FromSchema } from "json-schema-to-ts";

export const benchmarkTransportValues = ["public", "doublezero"] as const;

export const benchmarkMetricSummarySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    min: { type: "number" },
    p50: { type: "number" },
    p95: { type: "number" },
    max: { type: "number" }
  }
} as const;

export const gateBenchmarkMetricSchema = {
  type: "object",
  additionalProperties: false,
  required: ["transport", "status", "measuredAt"],
  properties: {
    transport: { enum: benchmarkTransportValues },
    status: { enum: ["succeeded", "failed"] },
    sourceInterface: { type: "string" },
    targetEndpoint: { type: "string" },
    packetCount: { type: "integer", minimum: 0 },
    packetsReceived: { type: "integer", minimum: 0 },
    lossPercent: { type: "number" },
    rttMs: benchmarkMetricSummarySchema,
    jitterMs: { type: "number" },
    forwardOneWayMs: benchmarkMetricSummarySchema,
    oneWayDiagnostics: {
      type: "object",
      additionalProperties: false,
      properties: {
        deviationMs: { type: "number" },
        clockErrorMs: { type: "number" }
      }
    },
    errorCode: { type: "string" },
    errorMessage: { type: "string" },
    measuredAt: { type: "string", format: "date-time" }
  }
} as const;

export const gateBenchmarkRouteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sourceGateId", "sourceGateName", "targetGateId", "targetGateName"],
  properties: {
    sourceGateId: { type: "string" },
    sourceGateName: { type: "string" },
    targetGateId: { type: "string" },
    targetGateName: { type: "string" },
    public: gateBenchmarkMetricSchema,
    doublezero: gateBenchmarkMetricSchema,
    delta: {
      type: "object",
      additionalProperties: false,
      properties: {
        rttP50Ms: { type: "number" },
        jitterMs: { type: "number" },
        lossPercent: { type: "number" },
        forwardOneWayP50Ms: { type: "number" }
      }
    }
  }
} as const;

export type BenchmarkTransport = typeof benchmarkTransportValues[number];
export type GateBenchmarkMetric = FromSchema<typeof gateBenchmarkMetricSchema>;
export type GateBenchmarkRoute = FromSchema<typeof gateBenchmarkRouteSchema>;
