import type { Queryable } from "../../db/queryable.js";
import { mustRow } from "../../support/db.js";

export interface SolanaPaymentReceiptRow {
  transactionSignature: string;
  accountId: string;
  sourceType: "direct_deposit";
  sourceId: string;
  tokenMint: string | null;
  amountBaseUnits: string | null;
  creditedAmountMinor: number;
  observedAt: string;
}

export interface SolanaDepositScanCursorRow {
  walletId: string;
  tokenMint: string;
  tokenAccounts: string[];
  latestSignatures: Record<string, string>;
  consecutiveFailures: number;
}

export async function claimSolanaPaymentReceipt(
  db: Queryable,
  input: {
    transactionSignature: string;
    accountId: string;
    sourceType: "direct_deposit";
    sourceId: string;
    tokenMint?: string | null;
    amountBaseUnits?: bigint | null;
    creditedAmountMinor: number;
    metadata?: Record<string, unknown>;
  }
): Promise<{ claimed: boolean; receipt: SolanaPaymentReceiptRow }> {
  const inserted = await db.query<SolanaPaymentReceiptRow>(
    `
      INSERT INTO solana_payment_receipts (
        transaction_signature,
        account_id,
        source_type,
        source_id,
        token_mint,
        amount_base_units,
        credited_amount_minor,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (transaction_signature) DO NOTHING
      RETURNING
        transaction_signature AS "transactionSignature",
        account_id AS "accountId",
        source_type AS "sourceType",
        source_id AS "sourceId",
        token_mint AS "tokenMint",
        amount_base_units::text AS "amountBaseUnits",
        credited_amount_minor::text::int AS "creditedAmountMinor",
        observed_at AS "observedAt"
    `,
    [
      input.transactionSignature,
      input.accountId,
      input.sourceType,
      input.sourceId,
      input.tokenMint ?? null,
      input.amountBaseUnits?.toString() ?? null,
      input.creditedAmountMinor,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  if (inserted.rows[0]) {
    return { claimed: true, receipt: inserted.rows[0] };
  }

  const existing = await db.query<SolanaPaymentReceiptRow>(
    `
      SELECT
        transaction_signature AS "transactionSignature",
        account_id AS "accountId",
        source_type AS "sourceType",
        source_id AS "sourceId",
        token_mint AS "tokenMint",
        amount_base_units::text AS "amountBaseUnits",
        credited_amount_minor::text::int AS "creditedAmountMinor",
        observed_at AS "observedAt"
      FROM solana_payment_receipts
      WHERE transaction_signature = $1
    `,
    [input.transactionSignature]
  );
  return { claimed: false, receipt: mustRow(existing) };
}

export async function listSolanaPaymentReceipts(
  db: Queryable,
  accountId: string,
  limit = 50
): Promise<SolanaPaymentReceiptRow[]> {
  const result = await db.query<SolanaPaymentReceiptRow>(
    `
      SELECT
        transaction_signature AS "transactionSignature",
        account_id AS "accountId",
        source_type AS "sourceType",
        source_id AS "sourceId",
        token_mint AS "tokenMint",
        amount_base_units::text AS "amountBaseUnits",
        credited_amount_minor::text::int AS "creditedAmountMinor",
        observed_at AS "observedAt"
      FROM solana_payment_receipts
      WHERE account_id = $1
      ORDER BY observed_at DESC, transaction_signature DESC
      LIMIT $2
    `,
    [accountId, Math.max(1, Math.min(200, Math.trunc(limit)))]
  );
  return result.rows;
}

export async function readSolanaDepositScanCursor(
  db: Queryable,
  walletId: string,
  tokenMint: string
): Promise<SolanaDepositScanCursorRow | null> {
  const result = await db.query<SolanaDepositScanCursorRow>(
    `
      SELECT
        wallet_id AS "walletId",
        token_mint AS "tokenMint",
        token_accounts AS "tokenAccounts",
        latest_signatures AS "latestSignatures",
        consecutive_failures AS "consecutiveFailures"
      FROM solana_deposit_scan_cursors
      WHERE wallet_id = $1 AND token_mint = $2
    `,
    [walletId, tokenMint]
  );
  return result.rows[0] ?? null;
}

export async function recordSolanaDepositScanSuccess(
  db: Queryable,
  input: {
    walletId: string;
    tokenMint: string;
    tokenAccounts: string[];
    latestSignatures: Record<string, string>;
    nextScanAt: string;
  }
): Promise<void> {
  await db.query(
    `
      INSERT INTO solana_deposit_scan_cursors (
        wallet_id,
        token_mint,
        token_accounts,
        latest_signatures,
        next_scan_at,
        last_scanned_at,
        last_success_at,
        consecutive_failures,
        last_error
      )
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::timestamptz, now(), now(), 0, NULL)
      ON CONFLICT (wallet_id, token_mint) DO UPDATE
      SET token_accounts = EXCLUDED.token_accounts,
          latest_signatures = EXCLUDED.latest_signatures,
          next_scan_at = EXCLUDED.next_scan_at,
          last_scanned_at = now(),
          last_success_at = now(),
          consecutive_failures = 0,
          last_error = NULL,
          updated_at = now()
    `,
    [
      input.walletId,
      input.tokenMint,
      JSON.stringify(input.tokenAccounts),
      JSON.stringify(input.latestSignatures),
      input.nextScanAt
    ]
  );
}

export async function recordSolanaDepositScanFailure(
  db: Queryable,
  input: {
    walletId: string;
    tokenMint: string;
    error: string;
    nextScanAt: string;
  }
): Promise<void> {
  await db.query(
    `
      INSERT INTO solana_deposit_scan_cursors (
        wallet_id,
        token_mint,
        next_scan_at,
        last_scanned_at,
        consecutive_failures,
        last_error
      )
      VALUES ($1, $2, $3::timestamptz, now(), 1, $4)
      ON CONFLICT (wallet_id, token_mint) DO UPDATE
      SET next_scan_at = EXCLUDED.next_scan_at,
          last_scanned_at = now(),
          consecutive_failures = solana_deposit_scan_cursors.consecutive_failures + 1,
          last_error = EXCLUDED.last_error,
          updated_at = now()
    `,
    [input.walletId, input.tokenMint, input.nextScanAt, input.error.slice(0, 500)]
  );
}

export async function readSolanaDepositRemainderForUpdate(
  db: Queryable,
  accountId: string,
  tokenMint: string
): Promise<bigint> {
  await db.query(
    `
      INSERT INTO solana_deposit_remainders (account_id, token_mint)
      VALUES ($1, $2)
      ON CONFLICT (account_id, token_mint) DO NOTHING
    `,
    [accountId, tokenMint]
  );
  const result = await db.query<{ remainderBaseUnits: string }>(
    `
      SELECT remainder_base_units::text AS "remainderBaseUnits"
      FROM solana_deposit_remainders
      WHERE account_id = $1 AND token_mint = $2
      FOR UPDATE
    `,
    [accountId, tokenMint]
  );
  return BigInt(mustRow(result).remainderBaseUnits);
}

export async function writeSolanaDepositRemainder(
  db: Queryable,
  accountId: string,
  tokenMint: string,
  remainderBaseUnits: bigint
): Promise<void> {
  await db.query(
    `
      UPDATE solana_deposit_remainders
      SET remainder_base_units = $3,
          updated_at = now()
      WHERE account_id = $1 AND token_mint = $2
    `,
    [accountId, tokenMint, remainderBaseUnits.toString()]
  );
}
