import test from "node:test";
import assert from "node:assert/strict";
import { calculateMarkedUpChargeMinor } from "./doublezero-usage-import.scenario.js";

test("DoubleZero usage markup is applied in basis points with ceiling rounding", () => {
  assert.equal(calculateMarkedUpChargeMinor(1000, 1500), 1150);
  assert.equal(calculateMarkedUpChargeMinor(1, 1500), 2);
  assert.equal(calculateMarkedUpChargeMinor(0, 1500), 0);
});

test("invalid markup falls back to pass-through cost", () => {
  assert.equal(calculateMarkedUpChargeMinor(123, -1), 123);
  assert.equal(calculateMarkedUpChargeMinor(123, 100_001), 123);
});
