import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSolanaPublicKey } from "./solana-address.js";

test("Solana addresses require a nonzero 32-byte base58 public key", () => {
  const publicKey = "AtfyG36NMHJqZKHmeoNTniFN3QwdXYA4oVXCbEqXr8zL";
  assert.equal(normalizeSolanaPublicKey(` ${publicKey} `), publicKey);
  assert.equal(normalizeSolanaPublicKey("11111111111111111111111111111112"), "11111111111111111111111111111112");
  assert.equal(normalizeSolanaPublicKey("not a base58 key"), "");
  assert.equal(normalizeSolanaPublicKey("11111111111111111111111111111111"), "");
});
