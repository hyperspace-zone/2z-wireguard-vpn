import assert from "node:assert/strict";
import test from "node:test";
import { requiredConfigPaymentLamports } from "./solana-config-payment.js";

test("SOL config payment requires the configured price plus the network fee", () => {
  assert.equal(requiredConfigPaymentLamports(100_000n, 5_000n), 105_000n);
  assert.equal(100_000n < requiredConfigPaymentLamports(100_000n, 5_000n), true);
  assert.equal(105_000n >= requiredConfigPaymentLamports(100_000n, 5_000n), true);
});

test("SOL config payment rejects invalid price and fee inputs", () => {
  assert.throws(() => requiredConfigPaymentLamports(0n, 5_000n), /invalid SOL config payment/);
  assert.throws(() => requiredConfigPaymentLamports(100_000n, -1n), /invalid SOL config payment/);
});
