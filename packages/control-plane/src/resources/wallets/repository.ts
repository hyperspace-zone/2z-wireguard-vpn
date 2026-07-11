import type { EncryptedJsonPayload } from "@hyperspace-zone/shared";
import type { Queryable } from "../../db/queryable.js";

export interface CustodialWalletRow {
  id: string;
  accountId: string;
  chain: "solana";
  publicKey: string;
  keyFingerprint: string;
  status: string;
  createdAt: string;
}

export async function findCustodialWallet(
  db: Queryable,
  accountId: string,
  chain = "solana"
): Promise<CustodialWalletRow | null> {
  const result = await db.query<CustodialWalletRow>(
    `
      SELECT
        id,
        account_id AS "accountId",
        chain,
        public_key AS "publicKey",
        key_fingerprint AS "keyFingerprint",
        status,
        created_at AS "createdAt"
      FROM custodial_wallets
      WHERE account_id = $1
        AND chain = $2
        AND status = 'active'
    `,
    [accountId, chain]
  );
  return result.rows[0] ?? null;
}

export async function insertCustodialWallet(
  db: Queryable,
  input: {
    accountId: string;
    chain: "solana";
    publicKey: string;
    encryptedKey: EncryptedJsonPayload;
    metadata?: Record<string, unknown>;
  }
): Promise<CustodialWalletRow | null> {
  const result = await db.query<CustodialWalletRow>(
    `
      INSERT INTO custodial_wallets (
        account_id,
        chain,
        public_key,
        encrypted_key,
        key_fingerprint,
        metadata
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb)
      ON CONFLICT (account_id, chain) DO NOTHING
      RETURNING
        id,
        account_id AS "accountId",
        chain,
        public_key AS "publicKey",
        key_fingerprint AS "keyFingerprint",
        status,
        created_at AS "createdAt"
    `,
    [
      input.accountId,
      input.chain,
      input.publicKey,
      JSON.stringify(input.encryptedKey),
      input.encryptedKey.keyFingerprint,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return result.rows[0] ?? null;
}

export async function readCustodialWalletEncryptedKey(
  db: Queryable,
  accountId: string,
  chain = "solana"
): Promise<{ wallet: CustodialWalletRow; encryptedKey: EncryptedJsonPayload } | null> {
  const result = await db.query<CustodialWalletRow & { encryptedKey: EncryptedJsonPayload }>(
    `
      SELECT
        id,
        account_id AS "accountId",
        chain,
        public_key AS "publicKey",
        key_fingerprint AS "keyFingerprint",
        status,
        created_at AS "createdAt",
        encrypted_key AS "encryptedKey"
      FROM custodial_wallets
      WHERE account_id = $1
        AND chain = $2
        AND status = 'active'
    `,
    [accountId, chain]
  );
  const row = result.rows[0];
  return row ? { wallet: row, encryptedKey: row.encryptedKey } : null;
}
