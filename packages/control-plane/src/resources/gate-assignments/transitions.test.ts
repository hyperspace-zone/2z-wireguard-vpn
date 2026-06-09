import assert from "node:assert/strict";
import test from "node:test";
import {
  appliedFromReportTransition,
  deadForProvisioningFailureTransition,
  desiredRevokedTransition,
  driftedAssignmentTransition,
  failedFromReportTransition,
  leasedAssignmentTransition,
  preparedFromReportTransition,
  provisioningFailureDeadCandidatePhases,
  queuedAfterAssignmentUpsertTransition,
  revokedFromReportTransition
} from "./transitions.js";

test("assignment transitions centralize apply and revoke phases", () => {
  assert.equal(queuedAfterAssignmentUpsertTransition("planned"), "queued");
  assert.equal(queuedAfterAssignmentUpsertTransition("applied"), "applied");
  assert.equal(leasedAssignmentTransition("apply_assignment", "queued"), "applying");
  assert.equal(leasedAssignmentTransition("revoke_assignment", "applied"), "applied");
  assert.equal(preparedFromReportTransition(), "prepared");
  assert.equal(appliedFromReportTransition(), "applied");
  assert.equal(revokedFromReportTransition(), "revoked");
  assert.equal(driftedAssignmentTransition(), "drifted");
});

test("assignment failure and desired revoke policies are canonical", () => {
  assert.equal(failedFromReportTransition(false), "retryable_failed");
  assert.equal(failedFromReportTransition(true), "dead");
  assert.deepEqual(desiredRevokedTransition(), {
    desiredState: "Revoked",
    incrementGeneration: true,
    statusPhase: "revoking"
  });
  assert.equal(deadForProvisioningFailureTransition("prepared"), "dead");
  assert.equal(deadForProvisioningFailureTransition("applied"), "applied");
  assert.deepEqual(provisioningFailureDeadCandidatePhases, [
    "planned",
    "queued",
    "leased",
    "applying",
    "prepared",
    "retryable_failed"
  ]);
});
