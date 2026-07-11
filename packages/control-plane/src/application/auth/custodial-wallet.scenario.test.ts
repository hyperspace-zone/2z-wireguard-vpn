import assert from "node:assert/strict";
import test from "node:test";
import { decryptJsonPayload, type EncryptedJsonPayload } from "@hyperspace-zone/shared";
import type { Queryable, TransactionalQueryable } from "../../db/queryable.js";
import { normalizeSolanaPublicKey } from "./solana-wallet.scenario.js";
import { ensureCustodialSolanaWallet } from "./custodial-wallet.scenario.js";

test("custodial Solana onboarding stores only an encrypted random seed", async () => {
  const accountId = "00000000-0000-4000-8000-000000000001";
  const encryptionKey = Buffer.alloc(32, 7);
  let encryptedKey: EncryptedJsonPayload | null = null;
  const client: Queryable = {
    async query<Row extends object>(sql: string, params: readonly unknown[] = []) {
      if (sql.includes("FROM custodial_wallets")) {
        return { rows: [] as Row[] };
      }
      if (sql.includes("INSERT INTO custodial_wallets")) {
        encryptedKey = JSON.parse(String(params[3])) as EncryptedJsonPayload;
        return { rows: [{
          id: "wallet-1",
          accountId,
          chain: "solana",
          publicKey: params[2],
          keyFingerprint: encryptedKey.keyFingerprint,
          status: "active",
          createdAt: "2026-07-11T00:00:00.000Z"
        } as Row] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }
  };
  const db: TransactionalQueryable = {
    query: client.query,
    async transaction<T>(fn: (transactionClient: Queryable) => Promise<T>): Promise<T> {
      return fn(client);
    }
  };

  const wallet = await ensureCustodialSolanaWallet(db, accountId, encryptionKey);

  assert.equal(wallet.custody, "hyperspace");
  assert.equal(wallet.canReceive, true);
  assert.ok(normalizeSolanaPublicKey(wallet.publicKey));
  assert.ok(encryptedKey);
  const decrypted = decryptJsonPayload<{ seed: string; format: string }>(encryptedKey, encryptionKey);
  assert.match(decrypted.seed, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(decrypted.format, "ed25519-jwk-seed-v1");
  assert.doesNotMatch(JSON.stringify(encryptedKey), new RegExp(decrypted.seed));
});
