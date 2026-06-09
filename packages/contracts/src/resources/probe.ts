export const probeRunSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "createdAt", "status"],
  properties: {
    id: { type: "string" },
    status: { enum: ["requested", "running", "succeeded", "failed"] },
    createdAt: { type: "string", format: "date-time" },
    completedAt: { type: "string", format: "date-time" }
  }
} as const;

export const probeResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "probeRunId", "source", "target", "metric", "value"],
  properties: {
    id: { type: "string" },
    probeRunId: { type: "string" },
    source: { type: "string" },
    target: { type: "string" },
    metric: { type: "string" },
    value: { type: "number" },
    unit: { type: "string" }
  }
} as const;
