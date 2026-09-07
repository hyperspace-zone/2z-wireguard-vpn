import assert from "node:assert/strict";
import test from "node:test";
import { currentTradingMeasurement, isTradingPath, tradingLatencyBand, tradingRoute } from "./trading.js";

test("new perpDEX sections support map, status and methodology without falling back to CEX", () => {
  for (const section of ["variational", "extended", "rise", "lighter"]) {
    assert.deepEqual(tradingRoute(`/trading/${section}/`), { section, view: "map" });
    assert.deepEqual(tradingRoute(`/trading/${section}/status`), { section, view: "status" });
    assert.deepEqual(tradingRoute(`/trading/${section}/about`), { section, view: "about" });
  }
  assert.deepEqual(tradingRoute("/trading/"), { section: "cex", view: "map" });
  assert.deepEqual(tradingRoute("/trading/unknown"), { section: "cex", view: "map" });
  assert.deepEqual(tradingRoute("/trading/hyperliquid"), { section: "hyperliquid", view: "map" });
  assert.deepEqual(tradingRoute("/trading/routes"), { section: "routes", view: "map" });
});

test("trading routes stay isolated from the VPN application", () => {
  assert.equal(isTradingPath("/trading"), true);
  assert.equal(isTradingPath("/trading/cex"), true);
  assert.equal(isTradingPath("/trading/prediction-markets/status"), true);
  assert.equal(isTradingPath("/benchmarks"), false);
  assert.equal(isTradingPath("/"), false);
});

test("map latency bands preserve the documented boundary colors", () => {
  assert.equal(tradingLatencyBand(0), "fast");
  assert.equal(tradingLatencyBand(49.99), "fast");
  assert.equal(tradingLatencyBand(50), "good");
  assert.equal(tradingLatencyBand(99.99), "good");
  assert.equal(tradingLatencyBand(100), "slow");
  assert.equal(tradingLatencyBand(199.99), "slow");
  assert.equal(tradingLatencyBand(200), "critical");
  assert.equal(tradingLatencyBand(undefined), "unavailable");
  assert.equal(tradingLatencyBand(Number.NaN), "unavailable");
  assert.equal(tradingLatencyBand(-1), "unavailable");
});

test("old map never ranks offline, expired or superseded samples as Live", () => {
  const now = Date.now();
  const sample = { nodeId: "node", targetId: "target", targetRevision: 2, networkProfile: "direct", status: "succeeded" as const, measuredAt: new Date(now).toISOString(), totalP50Ms: 1, sampleCount: 3, failureCount: 0 };
  const target = { revision: 2, intervalSeconds: 60 };
  assert.equal(currentTradingMeasurement({ fresh: true }, target, sample, now)?.status, "succeeded");
  assert.equal(currentTradingMeasurement({ fresh: false }, target, sample, now)?.errorCode, "Probe offline");
  assert.equal(currentTradingMeasurement({ fresh: true }, target, sample, now + 181_000)?.errorCode, "Measurement stale");
  assert.equal(currentTradingMeasurement({ fresh: true }, { ...target, revision: 3 }, sample, now)?.errorCode, "Measurement stale");
});
