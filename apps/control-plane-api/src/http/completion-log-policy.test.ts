import assert from "node:assert/strict";
import test from "node:test";
import { CompletionLogPolicy } from "./completion-log-policy.js";
test("public rejection logging is bounded independently from success logging", () => {
  const policy = new CompletionLogPolicy();
  let successes = 0, errors = 0;
  for (let i = 0; i < 10000; i++) {
    successes += Number(policy.allow("/v1/public/trading/latency", 200, 0));
    errors += Number(policy.allow("/v1/public/benchmarks/gate-matrix", 429, 0));
  }
  assert.equal(successes, 60); assert.equal(errors, 60);
  assert.equal(policy.allow("/v1/public/trading/latency", 503, 60_001), true);
});
test("probe successes are sampled; failures and operational mutations remain fully logged", () => {
  const policy = new CompletionLogPolicy();
  assert.equal(Array.from({ length: 1000 }, () => policy.allow("/v1/trading-probe/jobs/claim", 200, 0)).filter(Boolean).length, 10);
  assert.equal(policy.allow("/v1/trading-probe/jobs/claim", 500), true);
  assert.equal(policy.allow("/v1/gate/jobs/assignment/report", 200), true);
  assert.equal(policy.allow("/v1/public/sessions", 500), true);
  assert.equal(policy.allow("/v1/public/auth/email/request-code", 429), false);
});
