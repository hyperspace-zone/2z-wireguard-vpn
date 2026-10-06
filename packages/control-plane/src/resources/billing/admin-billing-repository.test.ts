import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable } from "../../db/queryable.js";
import {
  countBillingCustomers,
  listAdminBillingConfigs,
  listAdminSolanaConfigPayments,
  listAdminSolanaDeposits,
  readAdminTrafficSeries
} from "./prepaid-repository.js";

test("overview customer count is distinct active accounts without joining personal balances", async () => {
  let query = "";
  const db = { async query(text: string) { query = text; return { rows: [{ count: 3054 }] }; } } as unknown as Queryable;
  assert.equal(await countBillingCustomers(db), 3054);
  assert.match(query, /COUNT\(DISTINCT account_id\)/);
  assert.match(query, /disabled_at IS NULL/);
  assert.doesNotMatch(query, /billing_balance|sessions|LIMIT/);
});

test("admin config inventory uses exact incremental egress totals and native SOL payments", async () => {
  const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
  const db = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      return { rows: [] };
    }
  } as unknown as Queryable;

  await listAdminBillingConfigs(db, 25);
  await listAdminSolanaConfigPayments(db, 30);
  await listAdminSolanaDeposits(db, 35);

  assert.match(queries[0]?.text ?? "", /gate_assignment_usage_totals/);
  assert.doesNotMatch(queries[0]?.text ?? "", /gate_assignment_usage_deltas/);
  assert.match(queries[0]?.text ?? "", /gate_assignments\.role = 'Egress'/);
  assert.match(queries[0]?.text ?? "", /visible_sessions AS MATERIALIZED/);
  assert.match(queries[0]?.text ?? "", /session_gate_assignments AS MATERIALIZED/);
  assert.match(queries[0]?.text ?? "", /solana_config_payments\.status AS "paymentStatus"/);
  assert.deepEqual(queries[0]?.values, [25]);
  assert.match(queries[1]?.text ?? "", /FROM solana_config_payments/);
  assert.deepEqual(queries[1]?.values, [30]);
  assert.match(queries[2]?.text ?? "", /FROM solana_payment_receipts/);
  assert.match(queries[2]?.text ?? "", /LEFT JOIN custodial_wallets/);
  assert.deepEqual(queries[2]?.values, [35]);
});

test("admin traffic series is bounded, bucketed and optionally scoped to one config", async () => {
  const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
  const db = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      return { rows: [] };
    }
  } as unknown as Queryable;

  await readAdminTrafficSeries(db, {
    from: "2026-08-20T00:00:00.000Z",
    bucketSeconds: 900,
    sessionId: "90386aa8-73e5-4fe0-82c2-8b442e3ad47d"
  });

  assert.match(queries[0]?.text ?? "", /date_bin/);
  assert.match(queries[0]?.text ?? "", /window_end >= \$1::timestamptz/);
  assert.match(queries[0]?.text ?? "", /gate_assignments\.session_id = \$3::uuid/);
  assert.deepEqual(queries[0]?.values, [
    "2026-08-20T00:00:00.000Z",
    900,
    "90386aa8-73e5-4fe0-82c2-8b442e3ad47d"
  ]);
});
