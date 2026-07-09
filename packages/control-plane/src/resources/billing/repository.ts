import type { Queryable } from "../../db/queryable.js";
import { mustRow } from "../../support/db.js";

export interface BillingBalanceRow {
  accountId: string;
  balanceMinor: number;
  currency: string;
}

export interface LedgerEntryRow {
  id: string;
  entryType: string;
  amountMinor: number;
  currency: string;
  sourceType: string;
  sourceId: string;
  description: string;
  createdAt: string;
}

export interface TopupIntentRow {
  id: string;
  provider: string;
  status: string;
  amountMinor: number;
  currency: string;
  chain: string | null;
  tokenSymbol: string | null;
  tokenMint: string | null;
  treasuryAddress: string | null;
  reference: string;
  expectedSender: string | null;
  transactionSignature: string | null;
  expiresAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
}

export async function ensureBillingAccount(db: Queryable, accountId: string, currency = "USD"): Promise<void> {
  await db.query(
    `
      INSERT INTO billing_accounts (account_id, currency)
      VALUES ($1, $2)
      ON CONFLICT (account_id) DO UPDATE
      SET updated_at = now()
    `,
    [accountId, currency]
  );
}

export async function readBillingBalance(db: Queryable, accountId: string): Promise<BillingBalanceRow> {
  await ensureBillingAccount(db, accountId);
  const result = await db.query<BillingBalanceRow>(
    `
      SELECT
        billing_accounts.account_id AS "accountId",
        COALESCE(SUM(balance_ledger_entries.amount_minor), 0)::bigint::text::int AS "balanceMinor",
        billing_accounts.currency
      FROM billing_accounts
      LEFT JOIN balance_ledger_entries
        ON balance_ledger_entries.account_id = billing_accounts.account_id
       AND balance_ledger_entries.currency = billing_accounts.currency
      WHERE billing_accounts.account_id = $1
      GROUP BY billing_accounts.account_id, billing_accounts.currency
    `,
    [accountId]
  );
  return mustRow(result);
}

export async function listLedgerEntries(db: Queryable, accountId: string, limit = 50): Promise<LedgerEntryRow[]> {
  const result = await db.query<LedgerEntryRow>(
    `
      SELECT
        id,
        entry_type AS "entryType",
        amount_minor::text::int AS "amountMinor",
        currency,
        source_type AS "sourceType",
        source_id AS "sourceId",
        description,
        created_at AS "createdAt"
      FROM balance_ledger_entries
      WHERE account_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [accountId, limit]
  );
  return result.rows;
}

export async function insertTopupIntent(
  db: Queryable,
  input: {
    accountId: string;
    provider: string;
    status: string;
    amountMinor: number;
    currency: string;
    chain: string;
    tokenSymbol: string;
    tokenMint: string;
    treasuryAddress: string;
    reference: string;
    expectedSender?: string;
    expiresAt: string;
    metadata?: Record<string, unknown>;
  }
): Promise<TopupIntentRow> {
  const result = await db.query<TopupIntentRow>(
    `
      INSERT INTO topup_intents (
        account_id,
        provider,
        status,
        amount_minor,
        currency,
        chain,
        token_symbol,
        token_mint,
        treasury_address,
        reference,
        expected_sender,
        expires_at,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::jsonb)
      RETURNING
        id,
        provider,
        status,
        amount_minor::text::int AS "amountMinor",
        currency,
        chain,
        token_symbol AS "tokenSymbol",
        token_mint AS "tokenMint",
        treasury_address AS "treasuryAddress",
        reference,
        expected_sender AS "expectedSender",
        transaction_signature AS "transactionSignature",
        expires_at AS "expiresAt",
        submitted_at AS "submittedAt",
        confirmed_at AS "confirmedAt",
        created_at AS "createdAt"
    `,
    [
      input.accountId,
      input.provider,
      input.status,
      input.amountMinor,
      input.currency,
      input.chain,
      input.tokenSymbol,
      input.tokenMint,
      input.treasuryAddress,
      input.reference,
      input.expectedSender ?? null,
      input.expiresAt,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return mustRow(result);
}

export async function findTopupIntentForUpdate(
  db: Queryable,
  accountId: string,
  intentId: string
): Promise<TopupIntentRow | null> {
  const result = await db.query<TopupIntentRow>(
    `
      SELECT
        id,
        provider,
        status,
        amount_minor::text::int AS "amountMinor",
        currency,
        chain,
        token_symbol AS "tokenSymbol",
        token_mint AS "tokenMint",
        treasury_address AS "treasuryAddress",
        reference,
        expected_sender AS "expectedSender",
        transaction_signature AS "transactionSignature",
        expires_at AS "expiresAt",
        submitted_at AS "submittedAt",
        confirmed_at AS "confirmedAt",
        created_at AS "createdAt"
      FROM topup_intents
      WHERE account_id = $1
        AND id = $2
      FOR UPDATE
    `,
    [accountId, intentId]
  );
  return result.rows[0] ?? null;
}

export async function listTopupIntents(db: Queryable, accountId: string, limit = 20): Promise<TopupIntentRow[]> {
  const result = await db.query<TopupIntentRow>(
    `
      SELECT
        id,
        provider,
        status,
        amount_minor::text::int AS "amountMinor",
        currency,
        chain,
        token_symbol AS "tokenSymbol",
        token_mint AS "tokenMint",
        treasury_address AS "treasuryAddress",
        reference,
        expected_sender AS "expectedSender",
        transaction_signature AS "transactionSignature",
        expires_at AS "expiresAt",
        submitted_at AS "submittedAt",
        confirmed_at AS "confirmedAt",
        created_at AS "createdAt"
      FROM topup_intents
      WHERE account_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [accountId, limit]
  );
  return result.rows;
}

export async function submitTopupIntent(
  db: Queryable,
  input: {
    intentId: string;
    status: string;
    transactionSignature: string;
    confirmed: boolean;
  }
): Promise<void> {
  await db.query(
    `
      UPDATE topup_intents
      SET status = $2,
          transaction_signature = $3,
          submitted_at = COALESCE(submitted_at, now()),
          confirmed_at = CASE WHEN $4::boolean THEN COALESCE(confirmed_at, now()) ELSE confirmed_at END,
          updated_at = now()
      WHERE id = $1
    `,
    [input.intentId, input.status, input.transactionSignature, input.confirmed]
  );
}

export async function insertLedgerEntry(
  db: Queryable,
  input: {
    accountId: string;
    entryType: string;
    amountMinor: number;
    currency: string;
    sourceType: string;
    sourceId: string;
    description: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await db.query(
    `
      INSERT INTO balance_ledger_entries (
        account_id,
        entry_type,
        amount_minor,
        currency,
        source_type,
        source_id,
        description,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (source_type, source_id) DO NOTHING
    `,
    [
      input.accountId,
      input.entryType,
      input.amountMinor,
      input.currency,
      input.sourceType,
      input.sourceId,
      input.description,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}

export async function insertDoubleZeroTenantBillingSnapshot(
  db: Queryable,
  input: {
    cluster: string;
    tenant: string;
    paymentStatus?: string;
    tokenAccount?: string;
    billingRate?: string;
    lastDeductionDzEpoch?: number;
    raw: Record<string, unknown>;
  }
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `
      INSERT INTO doublezero_tenant_billing_snapshots (
        cluster,
        tenant,
        payment_status,
        token_account,
        billing_rate,
        last_deduction_dz_epoch,
        raw
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      RETURNING id
    `,
    [
      input.cluster,
      input.tenant,
      input.paymentStatus ?? null,
      input.tokenAccount ?? null,
      input.billingRate ?? null,
      input.lastDeductionDzEpoch ?? null,
      JSON.stringify(input.raw)
    ]
  );
  return mustRow(result).id;
}
