import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { decryptJsonPayload, encryptJsonPayload } from "@hyperspace-zone/shared";
import {
  parseArgs,
  reencryptCustodialWallet
} from "./migrate-custodial-wallets.mjs";

test("custodial wallet migration preserves the Solana address and changes encryption context", () => {
  const sourceAccountId = "11111111-1111-4111-8111-111111111111";
  const targetAccountId = "22222222-2222-4222-8222-222222222222";
  const sourceKey = randomBytes(32);
  const targetKey = randomBytes(32);
  const wallet = Keypair.generate();
  const publicKey = wallet.publicKey.toBase58();
  const seed = Buffer.from(wallet.secretKey.subarray(0, 32)).toString("base64url");
  const encryptedKey = encryptJsonPayload(
    { seed, format: "ed25519-jwk-seed-v1" },
    sourceKey,
    `custodial-wallet:${sourceAccountId}:solana:${publicKey}`
  );

  const migrated = reencryptCustodialWallet({
    encryptedKey,
    sourceAccountId,
    targetAccountId,
    publicKey,
    sourceKey,
    targetKey
  });
  const decrypted = decryptJsonPayload(migrated, targetKey);

  assert.equal(migrated.aad, `custodial-wallet:${targetAccountId}:solana:${publicKey}`);
  assert.equal(decrypted.seed, seed);
  assert.equal(Keypair.fromSeed(Buffer.from(decrypted.seed, "base64url")).publicKey.toBase58(), publicKey);
  assert.notEqual(migrated.keyFingerprint, encryptedKey.keyFingerprint);
});

test("custodial wallet migration rejects a mismatched source encryption context", () => {
  const sourceKey = randomBytes(32);
  const wallet = Keypair.generate();
  const publicKey = wallet.publicKey.toBase58();
  const encryptedKey = encryptJsonPayload(
    { seed: Buffer.from(wallet.secretKey.subarray(0, 32)).toString("base64url"), format: "ed25519-jwk-seed-v1" },
    sourceKey,
    `custodial-wallet:wrong-account:solana:${publicKey}`
  );
  assert.throws(() => reencryptCustodialWallet({
    encryptedKey,
    sourceAccountId: "11111111-1111-4111-8111-111111111111",
    targetAccountId: "22222222-2222-4222-8222-222222222222",
    publicKey,
    sourceKey,
    targetKey: randomBytes(32)
  }), /encryption context/);
});

test("wallet migration command is dry-run by default and deduplicates emails", () => {
  assert.deepEqual(parseArgs([
    "--source-env-file", "/source.env",
    "--target-env-file", "/target.env",
    "--email", "STAKR.SPACE@gmail.com",
    "--email", "stakr.space@gmail.com"
  ]), {
    sourceEnvFile: "/source.env",
    targetEnvFile: "/target.env",
    emails: ["stakr.space@gmail.com"],
    execute: false
  });
});
