import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  normalizeSolanaPublicKey,
  solanaWalletLinkMessage,
  verifySolanaSignature
} from "./solana-wallet.scenario.js";

test("Solana wallet signature verification accepts the matching Ed25519 signature", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  assert.equal(publicJwk.kty, "OKP");
  assert.equal(publicJwk.crv, "Ed25519");
  assert.equal(typeof publicJwk.x, "string");
  const publicX = publicJwk.x;
  assert.ok(publicX);

  const publicKeyBase58 = encodeBase58(Buffer.from(publicX, "base64url"));
  const message = solanaWalletLinkMessage({
    accountId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
    publicKey: publicKeyBase58,
    nonce: "nonce",
    issuedAt: "2026-07-09T00:00:00.000Z"
  });
  const signature = sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64");

  assert.equal(normalizeSolanaPublicKey(publicKeyBase58), publicKeyBase58);
  assert.equal(verifySolanaSignature(publicKeyBase58, message, signature), true);
  assert.equal(verifySolanaSignature(publicKeyBase58, `${message}\nmodified`, signature), false);
});

test("Solana wallet public key validation rejects invalid base58 and zero keys", () => {
  assert.equal(normalizeSolanaPublicKey("not a base58 key"), "");
  assert.equal(normalizeSolanaPublicKey(encodeBase58(Buffer.alloc(32))), "");
});

function encodeBase58(input: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of input) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const next = (digits[index] ?? 0) * 256 + carry;
      digits[index] = next % 58;
      carry = Math.floor(next / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let output = "";
  for (const byte of input) {
    if (byte !== 0) {
      break;
    }
    output += "1";
  }
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    output += alphabet[digits[index] ?? 0];
  }
  return output;
}
