import assert from "node:assert/strict";
import test from "node:test";
import {
  isSolanaTreasuryInitialized,
  isSolanaTransactionSimulationFailure,
  readSolanaConfigPaymentSignatureStatus,
  requiredConfigPaymentLamports
} from "./solana-config-payment.js";

test("SOL config payment treasury must already be rent exempt", () => {
  assert.equal(isSolanaTreasuryInitialized(0n, 890_880n), false);
  assert.equal(isSolanaTreasuryInitialized(890_879n, 890_880n), false);
  assert.equal(isSolanaTreasuryInitialized(890_880n, 890_880n), true);
});

test("SOL config payment requires the configured price plus the network fee", () => {
  assert.equal(requiredConfigPaymentLamports(100_000n, 5_000n), 105_000n);
  assert.equal(100_000n < requiredConfigPaymentLamports(100_000n, 5_000n), true);
  assert.equal(105_000n >= requiredConfigPaymentLamports(100_000n, 5_000n), true);
});

test("SOL config payment rejects invalid price and fee inputs", () => {
  assert.throws(() => requiredConfigPaymentLamports(0n, 5_000n), /invalid SOL config payment/);
  assert.throws(() => requiredConfigPaymentLamports(100_000n, -1n), /invalid SOL config payment/);
});

test("SOL config payment status falls back when RPC history is unavailable", async () => {
  const historyOptions: Array<boolean | undefined> = [];
  const connection = {
    async getSignatureStatuses(_signatures: string[], config?: { searchTransactionHistory?: boolean }) {
      historyOptions.push(config?.searchTransactionHistory);
      if (config?.searchTransactionHistory) {
        throw Object.assign(new Error("Transaction history is not available from this node"), { code: -32011 });
      }
      return { value: [{ err: null, confirmationStatus: "finalized" }] };
    }
  };

  const status = await readSolanaConfigPaymentSignatureStatus(connection, "signature");
  assert.equal(status?.confirmationStatus, "finalized");
  assert.deepEqual(historyOptions, [true, false]);
});

test("SOL config payment status preserves unrelated RPC errors", async () => {
  const connection = {
    async getSignatureStatuses() {
      throw Object.assign(new Error("RPC unavailable"), { code: -32000 });
    }
  };

  await assert.rejects(
    readSolanaConfigPaymentSignatureStatus(connection, "signature"),
    /RPC unavailable/
  );
});

test("SOL config payment recognizes deterministic simulation failures", () => {
  assert.equal(isSolanaTransactionSimulationFailure({
    name: "SendTransactionError",
    message: "Transaction simulation failed",
    transactionLogs: []
  }), true);
  assert.equal(isSolanaTransactionSimulationFailure(new Error("socket closed")), false);
});
