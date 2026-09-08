import assert from "node:assert/strict";
import test from "node:test";
import { compactAttemptResultSummary } from "./attempts.js";

test("gate benchmark attempt history keeps aggregates but discards raw packet samples", () => {
  const source = {
    results: [{
      transport: "doublezero",
      status: "succeeded",
      rttMs: { p50: 12.5 },
      samples: [{ sequence: 1, rttMs: 12.5 }]
    }],
    targetGateId: "gate-2"
  };
  const compacted = compactAttemptResultSummary(
    "probe",
    { kind: "gate_benchmark_v1" },
    source
  );

  assert.deepEqual(compacted, {
    results: [{
      transport: "doublezero",
      status: "succeeded",
      rttMs: { p50: 12.5 }
    }],
    targetGateId: "gate-2"
  });
  assert.notEqual(compacted, source);
  assert.deepEqual(source.results[0]?.samples, [{ sequence: 1, rttMs: 12.5 }]);
});

test("control and non-benchmark job summaries remain unchanged", () => {
  const summary = { material: { privateKey: "encrypted" } };
  assert.equal(compactAttemptResultSummary("apply_assignment", {}, summary), summary);
  assert.equal(compactAttemptResultSummary("probe", { kind: "gate_ntp_discovery_v1" }, summary), summary);
});
