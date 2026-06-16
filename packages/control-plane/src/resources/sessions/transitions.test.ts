import assert from "node:assert/strict";
import test from "node:test";
import {
  activeTransition,
  beginRevokingTransition,
  canHideSession,
  failedTransition,
  probingTransition,
  provisioningTransition,
  requestRevocationTransition,
  revokedTransition,
  schedulingTransition
} from "./transitions.js";

test("session transitions centralize requested lifecycle decisions", () => {
  assert.deepEqual(probingTransition(), { phase: "probing" });
  assert.deepEqual(schedulingTransition(), { phase: "scheduling" });
  assert.deepEqual(provisioningTransition(3, {}), {
    phase: "provisioning",
    observedGeneration: 3,
    lastError: null
  });
  assert.deepEqual(activeTransition(3), {
    phase: "active",
    observedGeneration: 3,
    lastError: null
  });
  assert.deepEqual(revokedTransition(4), {
    phase: "revoked",
    observedGeneration: 4,
    lastError: null
  });
});

test("session revocation transition preserves terminal revoked phase", () => {
  assert.deepEqual(requestRevocationTransition("active"), {
    desiredState: "Revoked",
    incrementGeneration: true,
    statusTransition: { phase: "revoking" }
  });
  assert.equal(requestRevocationTransition("revoked").statusTransition.phase, "revoked");
  assert.deepEqual(beginRevokingTransition("active"), { phase: "revoking" });
  assert.equal(beginRevokingTransition("failed"), null);
});

test("session failure and hide policies are canonical", () => {
  const error = { code: "boom", message: "failed" };
  assert.deepEqual(failedTransition(error), {
    phase: "failed",
    lastError: error
  });
  assert.equal(canHideSession("active", null), "not_revoked");
  assert.equal(canHideSession("revoked", "2026-06-09T00:00:00Z"), "deleted");
  assert.equal(canHideSession("failed", null), "can_hide");
});
