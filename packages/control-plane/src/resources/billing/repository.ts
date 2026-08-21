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
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
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
      RETURNING id
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
  return Boolean(result.rows[0]);
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

export async function insertDoubleZeroUsageImport(
  db: Queryable,
  input: {
    cluster: string;
    tenant: string;
    importSource: string;
    raw: Record<string, unknown>;
  }
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `
      INSERT INTO doublezero_usage_imports (
        cluster,
        tenant,
        import_source,
        raw
      )
      VALUES ($1, $2, $3, $4::jsonb)
      RETURNING id
    `,
    [input.cluster, input.tenant, input.importSource, JSON.stringify(input.raw)]
  );
  return mustRow(result).id;
}

export async function findAccountIdForSession(db: Queryable, sessionId: string): Promise<string | null> {
  const result = await db.query<{ accountId: string }>(
    `
      SELECT account_id AS "accountId"
      FROM sessions
      WHERE id = $1
    `,
    [sessionId]
  );
  return result.rows[0]?.accountId ?? null;
}

export async function findAccountId(db: Queryable, accountId: string): Promise<string | null> {
  const result = await db.query<{ accountId: string }>(
    `
      SELECT id AS "accountId"
      FROM accounts
      WHERE id = $1
    `,
    [accountId]
  );
  return result.rows[0]?.accountId ?? null;
}

export async function insertRatedUsageEvent(
  db: Queryable,
  input: {
    accountId: string;
    sessionId?: string;
    provider: string;
    sourceType: string;
    sourceId: string;
    windowStart: string;
    windowEnd: string;
    ingressGateName?: string;
    egressGateName?: string;
    bytesIn: number;
    bytesOut: number;
    costMinor: number;
    markupBps: number;
    chargeMinor: number;
    currency: string;
    metadata?: Record<string, unknown>;
  }
): Promise<{ id: string } | null> {
  const result = await db.query<{ id: string }>(
    `
      INSERT INTO rated_usage_events (
        account_id,
        session_id,
        provider,
        source_type,
        source_id,
        window_start,
        window_end,
        ingress_gate_name,
        egress_gate_name,
        bytes_in,
        bytes_out,
        cost_minor,
        markup_bps,
        charge_minor,
        currency,
        metadata
      )
      VALUES ($1, $2::uuid, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
      ON CONFLICT (source_type, source_id) DO NOTHING
      RETURNING id
    `,
    [
      input.accountId,
      input.sessionId ?? null,
      input.provider,
      input.sourceType,
      input.sourceId,
      input.windowStart,
      input.windowEnd,
      input.ingressGateName ?? null,
      input.egressGateName ?? null,
      input.bytesIn,
      input.bytesOut,
      input.costMinor,
      input.markupBps,
      input.chargeMinor,
      input.currency,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return result.rows[0] ?? null;
}

export interface BillingImportCursorRow {
  sourceName: string;
  etag: string | null;
  lastModified: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

export async function readBillingImportCursor(db: Queryable, sourceName: string): Promise<BillingImportCursorRow | null> {
  const result = await db.query<BillingImportCursorRow>(
    `
      SELECT
        source_name AS "sourceName",
        etag,
        last_modified AS "lastModified",
        last_success_at AS "lastSuccessAt",
        last_error_at AS "lastErrorAt",
        last_error AS "lastError"
      FROM billing_import_cursors
      WHERE source_name = $1
    `,
    [sourceName]
  );
  return result.rows[0] ?? null;
}

export async function recordBillingImportSuccess(
  db: Queryable,
  input: { sourceName: string; importId?: string; etag?: string | null; lastModified?: string | null }
): Promise<void> {
  await db.query(
    `
      INSERT INTO billing_import_cursors (
        source_name, etag, last_modified, last_import_id, last_success_at
      )
      VALUES ($1, $2, $3, $4::uuid, now())
      ON CONFLICT (source_name) DO UPDATE
      SET etag = COALESCE(EXCLUDED.etag, billing_import_cursors.etag),
          last_modified = COALESCE(EXCLUDED.last_modified, billing_import_cursors.last_modified),
          last_import_id = COALESCE(EXCLUDED.last_import_id, billing_import_cursors.last_import_id),
          last_success_at = now(),
          last_error = NULL,
          updated_at = now()
    `,
    [input.sourceName, input.etag ?? null, input.lastModified ?? null, input.importId ?? null]
  );
}

export async function recordBillingImportFailure(db: Queryable, sourceName: string, error: string): Promise<void> {
  await db.query(
    `
      INSERT INTO billing_import_cursors (source_name, last_error_at, last_error)
      VALUES ($1, now(), $2)
      ON CONFLICT (source_name) DO UPDATE
      SET last_error_at = now(),
          last_error = EXCLUDED.last_error,
          updated_at = now()
    `,
    [sourceName, error.slice(0, 2000)]
  );
}
