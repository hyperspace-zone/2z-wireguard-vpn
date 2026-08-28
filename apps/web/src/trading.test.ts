import assert from "node:assert/strict";
import test from "node:test";
import { isTradingPath, tradingLatencyBand } from "./trading.js";

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
