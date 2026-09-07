import assert from "node:assert/strict";
import test from "node:test";
import { compareReports, quantile } from "./trading-pair-check.mjs";
test("client comparison keeps failures, source and methodology boundaries", () => {
  const base = { version: 1, sourceHost: "same-server", environment: "staging", finishedAt: new Date().toISOString(), targets: [{ venue: "a" }, { venue: "b" }], samples: ["a", "b"].flatMap(venue => [1, 2, 3].map(() => ({ venue, ok: true, totalMs: 100 }))) };
  const direct = { ...base, profile: "direct" }; const vpn = { ...base, profile: "vpn", samples: base.samples.map(sample => ({ ...sample, totalMs: 60 })) };
  assert.equal(compareReports(direct, vpn).pairIndexSavedMs, 80);
  assert.throws(() => compareReports(direct, { ...vpn, sourceHost: "different" }));
  assert.throws(() => compareReports(direct, { ...vpn, targets: [] }));
  vpn.samples[0].ok = false; assert.equal(compareReports(direct, vpn).pairIndexSavedMs, null);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
});
