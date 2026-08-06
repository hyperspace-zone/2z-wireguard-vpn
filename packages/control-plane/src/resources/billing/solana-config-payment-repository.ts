import type { Queryable } from "../../db/queryable.js";
import { mustRow } from "../../support/db.js";

export type SolanaConfigPaymentStatus = "pending" | "processing" | "submitted" | "confirmed" | "failed";

export interface SolanaConfigPaymentRow {
  id: string;
  accountId: string;
  sessionId: string | null;
  sourceWalletAddress: string;
  treasuryAddress: string;
  amountLamports: string;
  feeLamports: string | null;
  status: SolanaConfigPaymentStatus;
  transactionSignature: string | null;
  rawTransaction: Buffer | null;
  recentBlockhash: string | null;
  lastValidBlockHeight: string | null;
  failureCode: string | null;
  failureReason: string | null;
  processingStartedAt: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const paymentColumns = `
  id,
  account_id AS "accountId",
  session_id AS "sessionId",
  source_wallet_address AS "sourceWalletAddress",
  treasury_address AS "treasuryAddress",
  amount_lamports::text AS "amountLamports",
  fee_lamports::text AS "feeLamports",
  status,
  transaction_signature AS "transactionSignature",
  raw_transaction AS "rawTransaction",
  recent_blockhash AS "recentBlockhash",
  last_valid_block_height::text AS "lastValidBlockHeight",
  failure_code AS "failureCode",
  failure_reason AS "failureReason",
  processing_started_at AS "processingStartedAt",
  submitted_at AS "submittedAt",
  confirmed_at AS "confirmedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export async function ensureSolanaConfigPayment(
  db: Queryable,
  input: {
    id: string;
    accountId: string;
    sessionId: string;
    sourceWalletAddress: string;
    treasuryAddress: string;
    amountLamports: bigint;
  }
): Promise<SolanaConfigPaymentRow> {
  await db.query(
    `
      INSERT INTO solana_config_payments (
        id, account_id, session_id, source_wallet_address, treasury_address, amount_lamports
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO NOTHING
    `,
    [input.id, input.accountId, input.sessionId, input.sourceWalletAddress, input.treasuryAddress, input.amountLamports.toString()]
  );
  const payment = await readSolanaConfigPayment(db, input.id);
  if (!payment || payment.accountId !== input.accountId) {
    throw new Error("config payment request belongs to another account");
  }
  if (
    payment.sourceWalletAddress !== input.sourceWalletAddress ||
    payment.treasuryAddress !== input.treasuryAddress ||
    payment.amountLamports !== input.amountLamports.toString()
  ) {
    throw new Error("config payment request parameters do not match the original request");
  }
  if (!payment.sessionId) {
    await db.query(
      `UPDATE solana_config_payments SET session_id = $2, updated_at = now() WHERE id = $1::uuid AND session_id IS NULL`,
      [input.id, input.sessionId]
    );
    return mustRow((await db.query<SolanaConfigPaymentRow>(
      `SELECT ${paymentColumns} FROM solana_config_payments WHERE id = $1::uuid`,
      [input.id]
    )));
  }
  if (payment.sessionId !== input.sessionId) {
    throw new Error("config payment request is already linked to another session");
  }
  return payment;
}

export async function readSolanaConfigPayment(db: Queryable, id: string): Promise<SolanaConfigPaymentRow | null> {
  const result = await db.query<SolanaConfigPaymentRow>(
    `SELECT ${paymentColumns} FROM solana_config_payments WHERE id = $1::uuid`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function claimSolanaConfigPaymentProcessing(db: Queryable, id: string): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `
      UPDATE solana_config_payments
      SET status = 'processing',
          processing_started_at = now(),
          failure_code = NULL,
          failure_reason = NULL,
          updated_at = now()
      WHERE id = $1::uuid
        AND (
          status IN ('pending', 'failed')
          OR (status = 'processing' AND processing_started_at < now() - interval '2 minutes')
        )
      RETURNING id
    `,
    [id]
  );
  return Boolean(result.rows[0]);
}

export async function recordSolanaConfigPaymentSubmission(
  db: Queryable,
  input: {
    id: string;
    signature: string;
    rawTransaction: Buffer;
    recentBlockhash: string;
    lastValidBlockHeight: number;
    feeLamports: bigint;
  }
): Promise<void> {
  await db.query(
    `
      UPDATE solana_config_payments
      SET status = 'submitted',
          transaction_signature = $2,
          raw_transaction = $3,
          recent_blockhash = $4,
          last_valid_block_height = $5,
          fee_lamports = $6,
          submitted_at = now(),
          updated_at = now()
      WHERE id = $1::uuid
    `,
    [input.id, input.signature, input.rawTransaction, input.recentBlockhash, input.lastValidBlockHeight, input.feeLamports.toString()]
  );
}

export async function recordSolanaConfigPaymentFeeEstimate(
  db: Queryable,
  id: string,
  feeLamports: bigint
): Promise<void> {
  await db.query(
    `
      UPDATE solana_config_payments
      SET fee_lamports = $2, updated_at = now()
      WHERE id = $1::uuid
    `,
    [id, feeLamports.toString()]
  );
}

export async function confirmSolanaConfigPayment(db: Queryable, id: string): Promise<void> {
  await db.query(
    `
      UPDATE solana_config_payments
      SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, now()), updated_at = now()
      WHERE id = $1::uuid
    `,
    [id]
  );
}

export async function failSolanaConfigPayment(
  db: Queryable,
  id: string,
  failureCode: string,
  failureReason: string
): Promise<void> {
  await db.query(
    `
      UPDATE solana_config_payments
      SET status = 'failed', failure_code = $2, failure_reason = $3, updated_at = now()
      WHERE id = $1::uuid
    `,
    [id, failureCode, failureReason.slice(0, 1000)]
  );
}
