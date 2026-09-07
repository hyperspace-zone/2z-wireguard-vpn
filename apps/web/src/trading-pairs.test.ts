import assert from "node:assert/strict";
import test from "node:test";
import { isTradingPairsPath, pairConfigUrl, pairMeasurementFresh } from "./trading-pairs.js";
import { tradingRouteIntent } from "./trading-route-intent.js";

test("pair routes and legacy alias do not hijack the map, benchmarks or VPN app", () => {
  for (const path of ["/trading/pairs", "/trading/pairs/", "/trading/routes", "/trading/routes/about"]) assert.ok(isTradingPairsPath(path));
  for (const path of ["/trading/cex", "/trading/lighter", "/trading/pairs-invalid", "/benchmarks", "/create-config", "/"]) assert.equal(isTradingPairsPath(path), false);
});
test("route intent survives authentication but expires and rejects unsafe URLs", () => {
  const id = "a".repeat(64); const now = 100000000;
  const saved = JSON.stringify({ id, createdAt: now - 1000 });
  assert.equal(tradingRouteIntent(null, saved, now), id);
  assert.equal(tradingRouteIntent("javascript:alert(1)", saved, now), "");
  assert.equal(tradingRouteIntent(null, saved, now + 86400000), "");
  assert.equal(tradingRouteIntent(null, "broken", now), "");
  assert.equal(tradingRouteIntent(id, null, now), id);
  assert.equal(pairConfigUrl(id), `/create-config?tradingRoute=${id}`);
  assert.throws(() => pairConfigUrl("/login"));
});
test("matrix freshness is target-specific and rejects offline nodes, future dates and old revisions", () => {
  const now = Date.now(); const venue = { id: "v", key: "v", category: "cex", displayName: "V", product: "Spot", protocol: "http_json" as const, measurement: "API", sortOrder: 0, revision: 2, intervalSeconds: 60 };
  const measurement = { nodeId: "n", targetId: "v", targetRevision: 2, networkProfile: "direct", status: "succeeded" as const, measuredAt: new Date(now - 120000).toISOString(), sampleCount: 3, failureCount: 0 };
  assert.equal(pairMeasurementFresh({ fresh: true }, venue, measurement, now), true);
  assert.equal(pairMeasurementFresh({ fresh: false }, venue, measurement, now), false);
  assert.equal(pairMeasurementFresh({ fresh: true }, venue, { ...measurement, targetRevision: 1 }, now), false);
  assert.equal(pairMeasurementFresh({ fresh: true }, venue, { ...measurement, measuredAt: new Date(now - 181000).toISOString() }, now), false);
});
