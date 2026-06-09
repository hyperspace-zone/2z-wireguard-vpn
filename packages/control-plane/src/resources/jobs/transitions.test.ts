import assert from "node:assert/strict";
import test from "node:test";
import {
  claimJobTransition,
  deadForSessionFailureTransition,
  expiredLeaseCandidateJobPhases,
  expiredLeaseTransition,
  queuedJobTransition,
  resolveReportedJobTransition,
  sessionFailureDeadCandidateJobPhases
} from "./transitions.js";

test("job report transitions centralize retry and terminal decisions", () => {
  assert.deepEqual(resolveReportedJobTransition("succeeded", 0, 5), {
    nextPhase: "succeeded",
    terminalFailure: false,
    retryDelaySeconds: null
  });
  assert.deepEqual(resolveReportedJobTransition("retryable_failed", 0, 5), {
    nextPhase: "retryable_failed",
    terminalFailure: false,
    retryDelaySeconds: 10
  });
  assert.deepEqual(resolveReportedJobTransition("retryable_failed", 4, 5), {
    nextPhase: "dead",
    terminalFailure: true,
    retryDelaySeconds: null
  });
});

test("job lease and session-failure transitions are canonical", () => {
  assert.deepEqual(claimJobTransition(), { phase: "leased", leaseSeconds: 60 });
  assert.equal(queuedJobTransition(), "queued");
  assert.equal(expiredLeaseTransition("leased"), "queued");
  assert.equal(expiredLeaseTransition("succeeded"), "succeeded");
  assert.equal(deadForSessionFailureTransition("running"), "dead");
  assert.equal(deadForSessionFailureTransition("succeeded"), "succeeded");
  assert.deepEqual(expiredLeaseCandidateJobPhases, ["leased", "running"]);
  assert.deepEqual(sessionFailureDeadCandidateJobPhases, ["queued", "leased", "running", "retryable_failed"]);
});
