import assert from "node:assert/strict";
import test from "node:test";
import type { PublicTradingLatencyResponse } from "@hyperspace-zone/contracts";
import { selectPublicTradingLatency } from "./trading-selection.js";

test("in-memory selection matches category, target, unknown-target fallback, and full-response semantics", () => {
  const data = { generatedAt: "original", nodes: [{ id: "n" }], targets: [
    { id: "a", key: "alpha", category: "cex", sortOrder: 1 },
    { id: "b", key: "beta", category: "cex", sortOrder: 2 },
    { id: "c", key: "gamma", category: "oracle", sortOrder: 3 }
  ], measurements: ["a", "b", "c"].map(targetId => ({ nodeId: "n", targetId, measuredAt: "original" })) } as unknown as PublicTradingLatencyResponse;
  assert.equal(selectPublicTradingLatency(data).measurements.length, 3);
  assert.equal(selectPublicTradingLatency(data, "cex").measurements.length, 2);
  assert.deepEqual(selectPublicTradingLatency(data, "cex", "beta").measurements.map(v => v.targetId), ["b"]);
  assert.deepEqual(selectPublicTradingLatency(data, "cex", "unknown").measurements.map(v => v.targetId), ["a"]);
  assert.equal(selectPublicTradingLatency(data, "unknown", "unknown").measurements.length, 0);
  assert.equal(selectPublicTradingLatency(data, "cex", "alpha").generatedAt, "original");
  assert.equal(data.measurements.length, 3);
});
