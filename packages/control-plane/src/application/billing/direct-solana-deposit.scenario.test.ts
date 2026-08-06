import assert from "node:assert/strict";
import test from "node:test";
import { convertDepositToBillingMinor } from "./direct-solana-deposit.scenario.js";

test("direct deposit conversion never credits more USDC than was received", () => {
  assert.deepEqual(convertDepositToBillingMinor(0n, 1_819_440n, 10_000n), {
    amountMinor: 181,
    remainderBaseUnits: 9_440n
  });
});

test("direct deposit conversion carries sub-cent USDC into the next deposit", () => {
  assert.deepEqual(convertDepositToBillingMinor(9_440n, 560n, 10_000n), {
    amountMinor: 1,
    remainderBaseUnits: 0n
  });
});
