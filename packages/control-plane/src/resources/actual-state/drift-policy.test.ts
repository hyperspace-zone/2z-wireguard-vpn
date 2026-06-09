import assert from "node:assert/strict";
import test from "node:test";
import { compareManagedHandles, hasStateDrift } from "./drift-policy.js";

test("state hash drift requires both desired and actual hashes", () => {
  assert.equal(hasStateDrift("a", "b"), true);
  assert.equal(hasStateDrift("a", "a"), false);
  assert.equal(hasStateDrift("a", null), false);
});

test("managed handle drift reports missing and orphan handles", () => {
  assert.deepEqual(compareManagedHandles(["hs-a", "hs-b"], ["hs-b", "hs-c"]), {
    drifted: true,
    missingHandles: ["hs-a"],
    orphanHandles: ["hs-c"]
  });
  assert.deepEqual(compareManagedHandles(["hs-a"], ["hs-a"]), {
    drifted: false,
    missingHandles: [],
    orphanHandles: []
  });
});
