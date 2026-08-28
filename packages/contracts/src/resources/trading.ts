import type { FromSchema } from "json-schema-to-ts";

export const tradingProbeProtocolValues = ["http_json", "websocket", "tcp_tls", "json_rpc"] as const;
export const tradingProbeStatusValues = ["succeeded", "failed"] as const;

export const tradingProbeTargetSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "key", "revision", "category", "displayName", "product", "protocol",
    "scheme", "hostname", "port", "path", "method", "headers", "timeoutMs",
    "sampleCount", "intervalSeconds", "expectedStatus", "responseKind", "metadata"
  ],
  properties: {
    id: { type: "string" },
    key: { type: "string" },
    revision: { type: "integer", minimum: 1 },
    category: { type: "string" },
    displayName: { type: "string" },
    product: { type: "string" },
    protocol: { enum: tradingProbeProtocolValues },
    scheme: { enum: ["https", "wss", "tls"] },
    hostname: { type: "string" },
    port: { type: "integer", minimum: 1, maximum: 65535 },
    path: { type: "string" },
    method: { enum: ["GET", "POST"] },
    headers: { type: "object", additionalProperties: { type: "string" } },
    body: {},
    expectedStatus: { type: "integer", minimum: 100, maximum: 599 },
    expectedBodyContains: { type: "string" },
    responseKind: { enum: ["json_object", "json_array", "json_number", "any"] },
    timeoutMs: { type: "integer", minimum: 250, maximum: 30000 },
    sampleCount: { type: "integer", minimum: 1, maximum: 20 },
    intervalSeconds: { type: "integer", minimum: 5 },
    metadata: { type: "object", additionalProperties: true }
  }
} as const;

export const tradingProbeJobSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "attemptNumber", "networkProfile", "target"],
  properties: {
    id: { type: "string" },
    attemptNumber: { type: "integer", minimum: 1 },
    networkProfile: { type: "string" },
    target: tradingProbeTargetSchema
  }
} as const;

export const tradingProbeHeartbeatRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["bootId", "agentVersion", "capabilities", "networkProfiles", "spoolDepth", "selfTest"],
  properties: {
    bootId: { type: "string" },
    agentVersion: { type: "string" },
    agentRevision: { type: "string" },
    agentBuiltAt: { type: "string", format: "date-time" },
    agentArtifactSha256: { type: "string" },
    agentInstalledAt: { type: "string", format: "date-time" },
    observedEndpoint: { type: "string" },
    capabilities: { type: "array", items: { type: "string" }, uniqueItems: true },
    networkProfiles: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
    spoolDepth: { type: "integer", minimum: 0 },
    selfTest: { type: "object", additionalProperties: true }
  }
} as const;

export const tradingProbeJobClaimRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["leaseOwner"],
  properties: {
    leaseOwner: { type: "string", minLength: 1, maxLength: 200 }
  }
} as const;

export const tradingProbeJobClaimResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["job"],
  properties: {
    job: { anyOf: [tradingProbeJobSchema, { type: "null" }] }
  }
} as const;

export const tradingProbeMetricSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "measuredAt", "sampleCount", "failureCount"],
  properties: {
    status: { enum: tradingProbeStatusValues },
    measuredAt: { type: "string", format: "date-time" },
    dnsMs: { type: "number", minimum: 0 },
    tcpMs: { type: "number", minimum: 0 },
    tlsMs: { type: "number", minimum: 0 },
    ttfbMs: { type: "number", minimum: 0 },
    totalP50Ms: { type: "number", minimum: 0 },
    totalP95Ms: { type: "number", minimum: 0 },
    totalMinMs: { type: "number", minimum: 0 },
    totalMaxMs: { type: "number", minimum: 0 },
    jitterMs: { type: "number", minimum: 0 },
    sampleCount: { type: "integer", minimum: 0 },
    failureCount: { type: "integer", minimum: 0 },
    httpStatus: { type: "integer" },
    responseClass: { type: "string" },
    resolvedIp: { type: "string" },
    errorCode: { type: "string" },
    errorMessage: { type: "string" }
  }
} as const;

export const tradingProbeJobReportRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["attemptNumber", "result"],
  properties: {
    attemptNumber: { type: "integer", minimum: 1 },
    result: tradingProbeMetricSummarySchema
  }
} as const;

export const tradingLatencyPublicNodeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "city", "country", "latitude", "longitude", "provider", "regionCode", "fresh"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    city: { type: "string" },
    country: { type: "string" },
    latitude: { type: "number" },
    longitude: { type: "number" },
    provider: { type: "string" },
    regionCode: { type: "string" },
    fresh: { type: "boolean" },
    lastSeenAt: { type: "string", format: "date-time" }
  }
} as const;

export const tradingLatencyPublicTargetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "key", "category", "displayName", "product", "protocol", "measurement", "sortOrder"],
  properties: {
    id: { type: "string" },
    key: { type: "string" },
    category: { type: "string" },
    displayName: { type: "string" },
    product: { type: "string" },
    protocol: { enum: tradingProbeProtocolValues },
    measurement: { type: "string" },
    sortOrder: { type: "integer" }
  }
} as const;

export const tradingLatencyPublicMeasurementSchema = {
  type: "object",
  additionalProperties: false,
  required: ["nodeId", "targetId", "networkProfile", "status", "measuredAt", "sampleCount", "failureCount"],
  properties: {
    nodeId: { type: "string" },
    targetId: { type: "string" },
    networkProfile: { type: "string" },
    status: { enum: tradingProbeStatusValues },
    measuredAt: { type: "string", format: "date-time" },
    dnsMs: { type: "number" },
    tcpMs: { type: "number" },
    tlsMs: { type: "number" },
    ttfbMs: { type: "number" },
    totalP50Ms: { type: "number" },
    totalP95Ms: { type: "number" },
    jitterMs: { type: "number" },
    sampleCount: { type: "integer" },
    failureCount: { type: "integer" },
    errorCode: { type: "string" }
  }
} as const;

export const publicTradingLatencyResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["generatedAt", "nodes", "targets", "measurements"],
  properties: {
    generatedAt: { type: "string", format: "date-time" },
    nodes: { type: "array", items: tradingLatencyPublicNodeSchema },
    targets: { type: "array", items: tradingLatencyPublicTargetSchema },
    measurements: { type: "array", items: tradingLatencyPublicMeasurementSchema }
  }
} as const;

export const createTradingProbeNodeRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "city", "country", "latitude", "longitude"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
    desiredState: { enum: ["Enabled", "Maintenance", "Disabled"] },
    placementKind: { enum: ["gate_host", "testnode", "dedicated"] },
    gateName: { type: "string" },
    city: { type: "string" },
    country: { type: "string" },
    latitude: { type: "number", minimum: -90, maximum: 90 },
    longitude: { type: "number", minimum: -180, maximum: 180 },
    provider: { type: "string" },
    regionCode: { type: "string" }
  }
} as const;

export const createTradingProbeNodeResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "token"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    token: { type: "string" }
  }
} as const;

export type TradingProbeTarget = FromSchema<typeof tradingProbeTargetSchema>;
export type TradingProbeJob = FromSchema<typeof tradingProbeJobSchema>;
export type TradingProbeMetricSummary = FromSchema<typeof tradingProbeMetricSummarySchema>;
export type PublicTradingLatencyResponse = FromSchema<typeof publicTradingLatencyResponseSchema>;
