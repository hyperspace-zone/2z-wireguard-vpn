import type { Queryable } from "../../db/queryable.js";
import { mustRow } from "../../support/db.js";

export interface BillingPlanVersionRow {
  id: string;
  code: string;
  version: number;
  displayName: string;
  currency: string;
  activeConfigMonthlyMinor: number;
  trafficPerGbMinor: number;
  gracePeriodSeconds: number;
  withdrawalCooldownSeconds: number;
  minimumWithdrawalMinor: number;
}

export interface BillingBucketsRow {
  cashMinor: number;
  promotionalMinor: number;
  reservedWithdrawalMinor: number;
  debtMinor: number;
}

export interface BillingAccountStateRow {
  state: "active" | "grace" | "suspended";
  overdrawnAt: string | null;
  suspensionDueAt: string | null;
  suspendedAt: string | null;
  withdrawalEligibleAt: string | null;
  lastSettledAt: string | null;
}

export interface RetailRatingCandidateRow {
  accountId: string;
  sessionId: string;
  sessionLabel: string | null;
  planVersionId: string;
  planCode: string;
  planVersion: number;
  activeConfigMonthlyMinor: number;
  trafficPerGbMinor: number;
  windowStart: string;
  windowEnd: string;
  activeSeconds: number;
  bytesToDestination: string;
  bytesFromDestination: string;
}

export interface BillingCustomerRow {
  accountId: string;
  email: string;
  displayName: string;
  state: string;
  balanceMinor: number;
  cashMinor: number;
  promotionalMinor: number;
  reservedWithdrawalMinor: number;
  debtMinor: number;
  activeConfigCount: number;
  planCode: string;
  planVersion: number;
  suspensionDueAt: string | null;
  lastSettledAt: string | null;
}

export interface WithdrawalRequestRow {
  id: string;
  status: string;
  amountMinor: number;
  currency: string;
  tokenSymbol: string;
  tokenMint: string;
  tokenAmountBaseUnits: string;
  destinationAddress: string;
  eligibleAt: string;
  transactionSignature: string | null;
  failureReason: string | null;
  requestedAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
}

export interface ClaimedWithdrawalRow extends WithdrawalRequestRow {
  accountId: string;
}

export interface CashSweepRequestRow {
  id: string;
  accountId: string;
  status: string;
  amountMinor: number;
  currency: string;
  tokenSymbol: string;
  tokenMint: string;
  tokenAmountBaseUnits: string;
  transactionSignature: string | null;
  attemptCount: number;
  failureReason: string | null;
  submittedAt: string | null;
}

export interface AccountUsageSummaryRow {
  sessionId: string;
  sessionLabel: string | null;
  activeSeconds: number;
  bytesToDestination: string;
  bytesFromDestination: string;
  chargeMinor: number;
  estimatedChargeMicrominor: string;
  lastRatedAt: string;
}

export interface BillingNotificationRow {
  id: string;
  accountId: string;
  notificationType: string;
  recipientEmail: string;
  payload: Record<string, unknown>;
  attemptCount: number;
}

export interface AdminBillingConfigRow {
  sessionId: string;
  accountId: string;
  customerEmail: string;
  label: string | null;
  phase: string;
  desiredState: string;
  ingressGateName: string | null;
  egressGateName: string | null;
  activeSeconds: number;
  payloadBytes: string;
  chargeMinor: number;
  createdAt: string;
  lastRatedAt: string | null;
}

export async function ensurePrepaidBillingState(db: Queryable, accountId: string): Promise<void> {
  await db.query(
    `
      WITH pilot AS (
        SELECT id
        FROM billing_plan_versions
        WHERE code = 'pilot' AND version = 1
      )
      INSERT INTO billing_account_plan_assignments (
        account_id, plan_version_id, assigned_by, reason
      )
      SELECT $1, pilot.id, 'system', 'Safe default plan'
      FROM pilot
      WHERE NOT EXISTS (
        SELECT 1
        FROM billing_account_plan_assignments
        WHERE account_id = $1 AND ends_at IS NULL
      )
      ON CONFLICT (account_id) WHERE ends_at IS NULL DO NOTHING
    `,
    [accountId]
  );
  await db.query(
    "INSERT INTO billing_balance_buckets (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING",
    [accountId]
  );
  await db.query(
    "INSERT INTO billing_account_accruals (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING",
    [accountId]
  );
  await db.query(
    "INSERT INTO billing_account_states (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING",
    [accountId]
  );
}

export async function readBillingBuckets(db: Queryable, accountId: string, forUpdate = false): Promise<BillingBucketsRow> {
  await ensurePrepaidBillingState(db, accountId);
  const result = await db.query<BillingBucketsRow>(
    `
      SELECT
        cash_minor::text::int AS "cashMinor",
        promotional_minor::text::int AS "promotionalMinor",
        reserved_withdrawal_minor::text::int AS "reservedWithdrawalMinor",
        debt_minor::text::int AS "debtMinor"
      FROM billing_balance_buckets
      WHERE account_id = $1
      ${forUpdate ? "FOR UPDATE" : ""}
    `,
    [accountId]
  );
  return mustRow(result);
}

export async function readBillingAccountState(
  db: Queryable,
  accountId: string,
  forUpdate = false
): Promise<BillingAccountStateRow> {
  await ensurePrepaidBillingState(db, accountId);
  const result = await db.query<BillingAccountStateRow>(
    `
      SELECT
        state,
        overdrawn_at AS "overdrawnAt",
        suspension_due_at AS "suspensionDueAt",
        suspended_at AS "suspendedAt",
        withdrawal_eligible_at AS "withdrawalEligibleAt",
        last_settled_at AS "lastSettledAt"
      FROM billing_account_states
      WHERE account_id = $1
      ${forUpdate ? "FOR UPDATE" : ""}
    `,
    [accountId]
  );
  return mustRow(result);
}

export async function readCurrentBillingPlan(db: Queryable, accountId: string): Promise<BillingPlanVersionRow> {
  await ensurePrepaidBillingState(db, accountId);
  const result = await db.query<BillingPlanVersionRow>(
    `
      SELECT
        billing_plan_versions.id,
        billing_plan_versions.code,
        billing_plan_versions.version,
        billing_plan_versions.display_name AS "displayName",
        billing_plan_versions.currency,
        billing_plan_versions.active_config_monthly_minor::text::int AS "activeConfigMonthlyMinor",
        billing_plan_versions.traffic_per_gb_minor::text::int AS "trafficPerGbMinor",
        billing_plan_versions.grace_period_seconds AS "gracePeriodSeconds",
        billing_plan_versions.withdrawal_cooldown_seconds AS "withdrawalCooldownSeconds",
        billing_plan_versions.minimum_withdrawal_minor::text::int AS "minimumWithdrawalMinor"
      FROM billing_account_plan_assignments
      JOIN billing_plan_versions
        ON billing_plan_versions.id = billing_account_plan_assignments.plan_version_id
      WHERE billing_account_plan_assignments.account_id = $1
        AND billing_account_plan_assignments.ends_at IS NULL
      ORDER BY billing_account_plan_assignments.starts_at DESC
      LIMIT 1
    `,
    [accountId]
  );
  return mustRow(result);
}

export async function listRetailRatingCandidates(
  db: Queryable,
  cutoff: string,
  limit = 250
): Promise<RetailRatingCandidateRow[]> {
  const result = await db.query<RetailRatingCandidateRow>(
    `
      WITH candidate_windows AS (
        SELECT
          sessions.account_id,
          sessions.id AS session_id,
          sessions.label AS session_label,
          billing_plan_versions.id AS plan_version_id,
          billing_plan_versions.code AS plan_code,
          billing_plan_versions.version AS plan_version,
          billing_plan_versions.active_config_monthly_minor,
          billing_plan_versions.traffic_per_gb_minor,
          GREATEST(
            billing_account_plan_assignments.starts_at,
            gate_assignment_status.applied_at,
            COALESCE(MAX(retail_usage_ratings.window_end), '-infinity'::timestamptz)
          ) AS window_start,
          LEAST(
            $1::timestamptz,
            COALESCE(billing_account_plan_assignments.ends_at, 'infinity'::timestamptz),
            COALESCE(gate_assignment_status.revoked_at, 'infinity'::timestamptz)
          ) AS window_end,
          gate_assignments.id AS assignment_id
        FROM sessions
        JOIN gate_assignments
          ON gate_assignments.session_id = sessions.id
         AND gate_assignments.role = 'Egress'
        JOIN gate_assignment_status
          ON gate_assignment_status.assignment_id = gate_assignments.id
         AND gate_assignment_status.applied_at IS NOT NULL
        JOIN billing_account_plan_assignments
          ON billing_account_plan_assignments.account_id = sessions.account_id
         AND billing_account_plan_assignments.starts_at < COALESCE(gate_assignment_status.revoked_at, $1::timestamptz)
         AND COALESCE(billing_account_plan_assignments.ends_at, 'infinity'::timestamptz) > gate_assignment_status.applied_at
        JOIN billing_plan_versions
          ON billing_plan_versions.id = billing_account_plan_assignments.plan_version_id
        LEFT JOIN retail_usage_ratings
          ON retail_usage_ratings.session_id = sessions.id
         AND retail_usage_ratings.plan_version_id = billing_plan_versions.id
        WHERE sessions.account_id IS NOT NULL
        GROUP BY
          sessions.account_id,
          sessions.id,
          sessions.label,
          billing_plan_versions.id,
          billing_plan_versions.code,
          billing_plan_versions.version,
          billing_plan_versions.active_config_monthly_minor,
          billing_plan_versions.traffic_per_gb_minor,
          billing_account_plan_assignments.starts_at,
          billing_account_plan_assignments.ends_at,
          gate_assignment_status.applied_at,
          gate_assignment_status.revoked_at,
          gate_assignments.id
      )
      SELECT
        candidate_windows.account_id AS "accountId",
        candidate_windows.session_id AS "sessionId",
        candidate_windows.session_label AS "sessionLabel",
        candidate_windows.plan_version_id AS "planVersionId",
        candidate_windows.plan_code AS "planCode",
        candidate_windows.plan_version AS "planVersion",
        candidate_windows.active_config_monthly_minor::text::int AS "activeConfigMonthlyMinor",
        candidate_windows.traffic_per_gb_minor::text::int AS "trafficPerGbMinor",
        candidate_windows.window_start AS "windowStart",
        candidate_windows.window_end AS "windowEnd",
        FLOOR(EXTRACT(EPOCH FROM candidate_windows.window_end - candidate_windows.window_start))::int AS "activeSeconds",
        COALESCE(SUM(
          FLOOR(
            gate_assignment_usage_deltas.forwarded_to_destination_bytes::numeric
            * EXTRACT(EPOCH FROM LEAST(gate_assignment_usage_deltas.window_end, candidate_windows.window_end)
                - GREATEST(gate_assignment_usage_deltas.window_start, candidate_windows.window_start))
            / NULLIF(EXTRACT(EPOCH FROM gate_assignment_usage_deltas.window_end - gate_assignment_usage_deltas.window_start), 0)
          )
        ), 0)::text AS "bytesToDestination",
        COALESCE(SUM(
          FLOOR(
            gate_assignment_usage_deltas.forwarded_from_destination_bytes::numeric
            * EXTRACT(EPOCH FROM LEAST(gate_assignment_usage_deltas.window_end, candidate_windows.window_end)
                - GREATEST(gate_assignment_usage_deltas.window_start, candidate_windows.window_start))
            / NULLIF(EXTRACT(EPOCH FROM gate_assignment_usage_deltas.window_end - gate_assignment_usage_deltas.window_start), 0)
          )
        ), 0)::text AS "bytesFromDestination"
      FROM candidate_windows
      LEFT JOIN gate_assignment_usage_deltas
        ON gate_assignment_usage_deltas.assignment_id = candidate_windows.assignment_id
       AND gate_assignment_usage_deltas.role = 'Egress'
       AND gate_assignment_usage_deltas.window_end > candidate_windows.window_start
       AND gate_assignment_usage_deltas.window_start < candidate_windows.window_end
      WHERE candidate_windows.window_end > candidate_windows.window_start
      GROUP BY
        candidate_windows.account_id,
        candidate_windows.session_id,
        candidate_windows.session_label,
        candidate_windows.plan_version_id,
        candidate_windows.plan_code,
        candidate_windows.plan_version,
        candidate_windows.active_config_monthly_minor,
        candidate_windows.traffic_per_gb_minor,
        candidate_windows.window_start,
        candidate_windows.window_end
      ORDER BY candidate_windows.window_end, candidate_windows.session_id
      LIMIT $2
    `,
    [cutoff, limit]
  );
  return result.rows;
}

export async function insertRetailUsageRating(
  db: Queryable,
  input: {
    accountId: string;
    sessionId: string;
    planVersionId: string;
    windowStart: string;
    windowEnd: string;
    activeSeconds: number;
    bytesToDestination: bigint;
    bytesFromDestination: bigint;
    chargeMicrominor: bigint;
    mode: "shadow" | "enforce";
    metadata: Record<string, unknown>;
  }
): Promise<{ id: string } | null> {
  const result = await db.query<{ id: string }>(
    `
      INSERT INTO retail_usage_ratings (
        account_id, session_id, plan_version_id, window_start, window_end,
        active_seconds, bytes_to_destination, bytes_from_destination,
        charge_microminor, mode, metadata
      )
      VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9, $10, $11::jsonb)
      ON CONFLICT (session_id, window_start, window_end) DO NOTHING
      RETURNING id
    `,
    [
      input.accountId,
      input.sessionId,
      input.planVersionId,
      input.windowStart,
      input.windowEnd,
      input.activeSeconds,
      input.bytesToDestination.toString(),
      input.bytesFromDestination.toString(),
      input.chargeMicrominor.toString(),
      input.mode,
      JSON.stringify(input.metadata)
    ]
  );
  return result.rows[0] ?? null;
}

export async function lockBillingAccrual(db: Queryable, accountId: string): Promise<bigint> {
  await ensurePrepaidBillingState(db, accountId);
  const result = await db.query<{ remainder: string }>(
    `
      SELECT microminor_remainder::text AS remainder
      FROM billing_account_accruals
      WHERE account_id = $1
      FOR UPDATE
    `,
    [accountId]
  );
  return BigInt(mustRow(result).remainder);
}

export async function updateBillingAccrual(db: Queryable, accountId: string, remainder: bigint): Promise<void> {
  await db.query(
    `
      UPDATE billing_account_accruals
      SET microminor_remainder = $2, updated_at = now()
      WHERE account_id = $1
    `,
    [accountId, remainder.toString()]
  );
}

export async function markRatingPosted(db: Queryable, ratingId: string, chargeMinor: number): Promise<void> {
  await db.query(
    "UPDATE retail_usage_ratings SET posted_charge_minor = $2 WHERE id = $1",
    [ratingId, chargeMinor]
  );
}

export async function writeBillingBuckets(
  db: Queryable,
  accountId: string,
  buckets: BillingBucketsRow
): Promise<void> {
  await db.query(
    `
      UPDATE billing_balance_buckets
      SET cash_minor = $2,
          promotional_minor = $3,
          reserved_withdrawal_minor = $4,
          debt_minor = $5,
          updated_at = now()
      WHERE account_id = $1
    `,
    [
      accountId,
      buckets.cashMinor,
      buckets.promotionalMinor,
      buckets.reservedWithdrawalMinor,
      buckets.debtMinor
    ]
  );
}

export async function creditCashBucket(db: Queryable, accountId: string, amountMinor: number): Promise<void> {
  await ensurePrepaidBillingState(db, accountId);
  await db.query(
    `
      UPDATE billing_balance_buckets
      SET cash_minor = cash_minor + $2, updated_at = now()
      WHERE account_id = $1
    `,
    [accountId, amountMinor]
  );
}

export async function updateBillingAccountState(
  db: Queryable,
  accountId: string,
  input: {
    state: "active" | "grace" | "suspended";
    overdrawnAt: string | null;
    suspensionDueAt: string | null;
    suspendedAt: string | null;
    withdrawalEligibleAt: string | null;
    settledAt: string;
  }
): Promise<void> {
  await db.query(
    `
      UPDATE billing_account_states
      SET state = $2,
          overdrawn_at = $3::timestamptz,
          suspension_due_at = $4::timestamptz,
          suspended_at = $5::timestamptz,
          withdrawal_eligible_at = $6::timestamptz,
          last_settled_at = $7::timestamptz,
          updated_at = now()
      WHERE account_id = $1
    `,
    [
      accountId,
      input.state,
      input.overdrawnAt,
      input.suspensionDueAt,
      input.suspendedAt,
      input.withdrawalEligibleAt,
      input.settledAt
    ]
  );
}

export async function listNonTerminalAccountSessions(
  db: Queryable,
  accountId: string
): Promise<Array<{ id: string; label: string | null }>> {
  const result = await db.query<{ id: string; label: string | null }>(
    `
      SELECT sessions.id, sessions.label
      FROM sessions
      JOIN session_status ON session_status.session_id = sessions.id
      WHERE sessions.account_id = $1
        AND sessions.desired_state <> 'Revoked'
        AND session_status.phase NOT IN ('revoked', 'failed')
      ORDER BY sessions.created_at
      FOR UPDATE OF sessions
    `,
    [accountId]
  );
  return result.rows;
}

export async function listBillingAccountsNeedingStateCheck(db: Queryable, limit = 250): Promise<string[]> {
  const result = await db.query<{ accountId: string }>(
    `
      SELECT account_id AS "accountId"
      FROM billing_account_states
      WHERE state <> 'active'
      ORDER BY COALESCE(suspension_due_at, updated_at)
      LIMIT $1
    `,
    [limit]
  );
  return result.rows.map((row) => row.accountId);
}

export async function enqueueBillingNotification(
  db: Queryable,
  input: {
    accountId: string;
    notificationType: string;
    dedupeKey: string;
    payload: Record<string, unknown>;
  }
): Promise<void> {
  await db.query(
    `
      INSERT INTO billing_notification_outbox (
        account_id, notification_type, dedupe_key, recipient_email, payload
      )
      SELECT $1, $2, $3, users.email, $4::jsonb
      FROM users
      WHERE users.account_id = $1 AND users.disabled_at IS NULL
      ORDER BY users.created_at
      LIMIT 1
      ON CONFLICT (dedupe_key) DO NOTHING
    `,
    [input.accountId, input.notificationType, input.dedupeKey, JSON.stringify(input.payload)]
  );
}

export async function userHasRole(db: Queryable, userId: string, role: string): Promise<boolean> {
  const result = await db.query<{ allowed: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM user_roles WHERE user_id = $1 AND role = $2) AS allowed",
    [userId, role]
  );
  return result.rows[0]?.allowed === true;
}

export async function listBillingCustomers(db: Queryable, limit = 200): Promise<BillingCustomerRow[]> {
  const result = await db.query<BillingCustomerRow>(
    `
      SELECT
        accounts.id AS "accountId",
        users.email::text,
        accounts.display_name AS "displayName",
        COALESCE(billing_account_states.state, 'active') AS state,
        (COALESCE(billing_balance_buckets.cash_minor, 0)
          + COALESCE(billing_balance_buckets.promotional_minor, 0)
          - COALESCE(billing_balance_buckets.debt_minor, 0))::text::int AS "balanceMinor",
        COALESCE(billing_balance_buckets.cash_minor, 0)::text::int AS "cashMinor",
        COALESCE(billing_balance_buckets.promotional_minor, 0)::text::int AS "promotionalMinor",
        COALESCE(billing_balance_buckets.reserved_withdrawal_minor, 0)::text::int AS "reservedWithdrawalMinor",
        COALESCE(billing_balance_buckets.debt_minor, 0)::text::int AS "debtMinor",
        COUNT(sessions.id) FILTER (
          WHERE sessions.desired_state <> 'Revoked'
            AND session_status.phase NOT IN ('revoked', 'failed')
        )::int AS "activeConfigCount",
        COALESCE(billing_plan_versions.code, 'pilot') AS "planCode",
        COALESCE(billing_plan_versions.version, 1) AS "planVersion",
        billing_account_states.suspension_due_at AS "suspensionDueAt",
        billing_account_states.last_settled_at AS "lastSettledAt"
      FROM accounts
      JOIN LATERAL (
        SELECT email
        FROM users
        WHERE users.account_id = accounts.id AND users.disabled_at IS NULL
        ORDER BY users.created_at
        LIMIT 1
      ) users ON true
      LEFT JOIN billing_balance_buckets ON billing_balance_buckets.account_id = accounts.id
      LEFT JOIN billing_account_states ON billing_account_states.account_id = accounts.id
      LEFT JOIN billing_account_plan_assignments
        ON billing_account_plan_assignments.account_id = accounts.id
       AND billing_account_plan_assignments.ends_at IS NULL
      LEFT JOIN billing_plan_versions ON billing_plan_versions.id = billing_account_plan_assignments.plan_version_id
      LEFT JOIN sessions ON sessions.account_id = accounts.id
      LEFT JOIN session_status ON session_status.session_id = sessions.id
      GROUP BY
        accounts.id,
        users.email,
        billing_account_states.state,
        billing_balance_buckets.cash_minor,
        billing_balance_buckets.promotional_minor,
        billing_balance_buckets.reserved_withdrawal_minor,
        billing_balance_buckets.debt_minor,
        billing_plan_versions.code,
        billing_plan_versions.version,
        billing_account_states.suspension_due_at,
        billing_account_states.last_settled_at
      ORDER BY accounts.created_at DESC
      LIMIT $1
    `,
    [limit]
  );
  return result.rows;
}

export async function listAdminBillingConfigs(db: Queryable, limit = 500): Promise<AdminBillingConfigRow[]> {
  const result = await db.query<AdminBillingConfigRow>(
    `
      SELECT
        sessions.id AS "sessionId",
        sessions.account_id AS "accountId",
        users.email::text AS "customerEmail",
        sessions.label,
        session_status.phase::text,
        sessions.desired_state::text AS "desiredState",
        session_status.selected_path->>'ingressGateName' AS "ingressGateName",
        session_status.selected_path->>'egressGateName' AS "egressGateName",
        COALESCE(SUM(retail_usage_ratings.active_seconds), 0)::text::int AS "activeSeconds",
        COALESCE(SUM(retail_usage_ratings.bytes_to_destination + retail_usage_ratings.bytes_from_destination), 0)::text AS "payloadBytes",
        COALESCE(SUM(retail_usage_ratings.posted_charge_minor), 0)::text::int AS "chargeMinor",
        sessions.created_at AS "createdAt",
        MAX(retail_usage_ratings.window_end) AS "lastRatedAt"
      FROM sessions
      JOIN session_status ON session_status.session_id = sessions.id
      JOIN LATERAL (
        SELECT email FROM users
        WHERE users.account_id = sessions.account_id AND users.disabled_at IS NULL
        ORDER BY users.created_at LIMIT 1
      ) users ON true
      LEFT JOIN retail_usage_ratings ON retail_usage_ratings.session_id = sessions.id
      WHERE sessions.account_id IS NOT NULL
      GROUP BY sessions.id, users.email, session_status.phase, session_status.selected_path
      ORDER BY sessions.created_at DESC
      LIMIT $1
    `,
    [limit]
  );
  return result.rows;
}

export async function insertDoubleZeroTenantCostEvent(
  db: Queryable,
  input: {
    cluster: string;
    tenant: string;
    dzEpoch: number;
    tokenSymbol: string;
    tokenMint: string;
    amountBaseUnits: bigint;
    usdCostMinor?: number;
    quote?: Record<string, unknown>;
  }
): Promise<{ id: string; inserted: boolean }> {
  const result = await db.query<{ id: string; inserted: boolean }>(
    `
      INSERT INTO doublezero_tenant_cost_events (
        cluster, tenant, dz_epoch, token_symbol, token_mint,
        amount_base_units, usd_cost_minor, quote
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (cluster, tenant, dz_epoch) DO UPDATE
      SET token_symbol = EXCLUDED.token_symbol,
          token_mint = EXCLUDED.token_mint,
          amount_base_units = EXCLUDED.amount_base_units,
          usd_cost_minor = COALESCE(EXCLUDED.usd_cost_minor, doublezero_tenant_cost_events.usd_cost_minor),
          quote = doublezero_tenant_cost_events.quote || EXCLUDED.quote,
          observed_at = now()
      RETURNING id, (xmax = 0) AS inserted
    `,
    [
      input.cluster, input.tenant, input.dzEpoch, input.tokenSymbol, input.tokenMint,
      input.amountBaseUnits.toString(), input.usdCostMinor ?? null, JSON.stringify(input.quote ?? {})
    ]
  );
  return mustRow(result);
}

export async function assignBillingPlan(
  db: Queryable,
  input: { accountId: string; planCode: string; planVersion: number; assignedBy: string; reason: string }
): Promise<void> {
  const plan = await db.query<{ id: string }>(
    "SELECT id FROM billing_plan_versions WHERE code = $1 AND version = $2 AND retired_at IS NULL",
    [input.planCode, input.planVersion]
  );
  const planId = plan.rows[0]?.id;
  if (!planId) {
    throw new Error("billing plan not found");
  }
  await db.query(
    `
      UPDATE billing_account_plan_assignments
      SET ends_at = now()
      WHERE account_id = $1 AND ends_at IS NULL
    `,
    [input.accountId]
  );
  await db.query(
    `
      INSERT INTO billing_account_plan_assignments (
        account_id, plan_version_id, assigned_by, reason
      ) VALUES ($1, $2, $3, $4)
    `,
    [input.accountId, planId, input.assignedBy, input.reason]
  );
}

export async function listBillingPlans(db: Queryable): Promise<BillingPlanVersionRow[]> {
  const result = await db.query<BillingPlanVersionRow>(
    `
      SELECT
        id,
        code,
        version,
        display_name AS "displayName",
        currency,
        active_config_monthly_minor::text::int AS "activeConfigMonthlyMinor",
        traffic_per_gb_minor::text::int AS "trafficPerGbMinor",
        grace_period_seconds AS "gracePeriodSeconds",
        withdrawal_cooldown_seconds AS "withdrawalCooldownSeconds",
        minimum_withdrawal_minor::text::int AS "minimumWithdrawalMinor"
      FROM billing_plan_versions
      ORDER BY code, version DESC
    `
  );
  return result.rows;
}

export async function createBillingPlanVersion(
  db: Queryable,
  input: {
    code: string;
    version: number;
    displayName: string;
    activeConfigMonthlyMinor: number;
    trafficPerGbMinor: number;
    gracePeriodSeconds: number;
    withdrawalCooldownSeconds: number;
    minimumWithdrawalMinor: number;
    createdBy: string;
  }
): Promise<BillingPlanVersionRow> {
  const result = await db.query<BillingPlanVersionRow>(
    `
      INSERT INTO billing_plan_versions (
        code, version, display_name, active_config_monthly_minor, traffic_per_gb_minor,
        grace_period_seconds, withdrawal_cooldown_seconds, minimum_withdrawal_minor, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      RETURNING
        id,
        code,
        version,
        display_name AS "displayName",
        currency,
        active_config_monthly_minor::text::int AS "activeConfigMonthlyMinor",
        traffic_per_gb_minor::text::int AS "trafficPerGbMinor",
        grace_period_seconds AS "gracePeriodSeconds",
        withdrawal_cooldown_seconds AS "withdrawalCooldownSeconds",
        minimum_withdrawal_minor::text::int AS "minimumWithdrawalMinor"
    `,
    [
      input.code,
      input.version,
      input.displayName,
      input.activeConfigMonthlyMinor,
      input.trafficPerGbMinor,
      input.gracePeriodSeconds,
      input.withdrawalCooldownSeconds,
      input.minimumWithdrawalMinor,
      JSON.stringify({ createdBy: input.createdBy })
    ]
  );
  return mustRow(result);
}

export async function grantUserRoleByEmail(
  db: Queryable,
  input: { email: string; role: string; grantedBy: string }
): Promise<boolean> {
  const result = await db.query<{ userId: string }>(
    `
      INSERT INTO user_roles (user_id, role, granted_by)
      SELECT users.id, $2, $3
      FROM users
      WHERE users.email = $1 AND users.disabled_at IS NULL
      ON CONFLICT (user_id, role) DO UPDATE
      SET granted_by = EXCLUDED.granted_by, granted_at = now()
      RETURNING user_id AS "userId"
    `,
    [input.email, input.role, input.grantedBy]
  );
  return Boolean(result.rows[0]);
}

export async function insertWithdrawalRequest(
  db: Queryable,
  input: {
    accountId: string;
    userId: string;
    amountMinor: number;
    tokenSymbol: string;
    tokenMint: string;
    tokenAmountBaseUnits: bigint;
    destinationAddress: string;
    eligibleAt: string;
  }
): Promise<WithdrawalRequestRow> {
  const result = await db.query<WithdrawalRequestRow>(
    `
      INSERT INTO withdrawal_requests (
        account_id, requested_by_user_id, amount_minor, token_symbol, token_mint,
        token_amount_base_units, destination_address, eligible_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
      RETURNING
        id, status, amount_minor::text::int AS "amountMinor", currency,
        token_symbol AS "tokenSymbol", token_mint AS "tokenMint",
        token_amount_base_units::text AS "tokenAmountBaseUnits",
        destination_address AS "destinationAddress", eligible_at AS "eligibleAt",
        transaction_signature AS "transactionSignature", failure_reason AS "failureReason",
        requested_at AS "requestedAt", submitted_at AS "submittedAt", confirmed_at AS "confirmedAt"
    `,
    [
      input.accountId,
      input.userId,
      input.amountMinor,
      input.tokenSymbol,
      input.tokenMint,
      input.tokenAmountBaseUnits.toString(),
      input.destinationAddress,
      input.eligibleAt
    ]
  );
  return mustRow(result);
}

export async function insertCashSweepRequest(
  db: Queryable,
  input: {
    accountId: string;
    sourceType: string;
    sourceId: string;
    amountMinor: number;
    tokenSymbol: string;
    tokenMint: string;
    tokenAmountBaseUnits: bigint;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  if (input.amountMinor <= 0 || input.tokenAmountBaseUnits <= 0n) return;
  await db.query(
    `
      INSERT INTO billing_cash_sweep_requests (
        account_id, source_type, source_id, amount_minor, token_symbol,
        token_mint, token_amount_base_units, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (source_type, source_id) DO NOTHING
    `,
    [
      input.accountId,
      input.sourceType,
      input.sourceId,
      input.amountMinor,
      input.tokenSymbol,
      input.tokenMint,
      input.tokenAmountBaseUnits.toString(),
      JSON.stringify(input.metadata ?? {})
    ]
  );
}

export async function claimCashSweepRequest(db: Queryable): Promise<CashSweepRequestRow | null> {
  const result = await db.query<CashSweepRequestRow>(
    `
      WITH candidate AS (
        SELECT id
        FROM billing_cash_sweep_requests
        WHERE status IN ('pending', 'failed')
          AND next_attempt_at <= now()
        ORDER BY next_attempt_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE billing_cash_sweep_requests
      SET status = 'processing', failure_reason = NULL, updated_at = now()
      FROM candidate
      WHERE billing_cash_sweep_requests.id = candidate.id
      RETURNING
        billing_cash_sweep_requests.id,
        billing_cash_sweep_requests.account_id AS "accountId",
        billing_cash_sweep_requests.status,
        billing_cash_sweep_requests.amount_minor::text::int AS "amountMinor",
        billing_cash_sweep_requests.currency,
        billing_cash_sweep_requests.token_symbol AS "tokenSymbol",
        billing_cash_sweep_requests.token_mint AS "tokenMint",
        billing_cash_sweep_requests.token_amount_base_units::text AS "tokenAmountBaseUnits",
        billing_cash_sweep_requests.transaction_signature AS "transactionSignature",
        billing_cash_sweep_requests.attempt_count AS "attemptCount",
        billing_cash_sweep_requests.failure_reason AS "failureReason",
        billing_cash_sweep_requests.submitted_at AS "submittedAt"
    `
  );
  return result.rows[0] ?? null;
}

export async function listSubmittedCashSweeps(db: Queryable, limit = 100): Promise<CashSweepRequestRow[]> {
  const result = await db.query<CashSweepRequestRow>(
    `
      SELECT
        id, account_id AS "accountId", status,
        amount_minor::text::int AS "amountMinor", currency,
        token_symbol AS "tokenSymbol", token_mint AS "tokenMint",
        token_amount_base_units::text AS "tokenAmountBaseUnits",
        transaction_signature AS "transactionSignature",
        attempt_count AS "attemptCount", failure_reason AS "failureReason",
        submitted_at AS "submittedAt"
      FROM billing_cash_sweep_requests
      WHERE status = 'submitted'
      ORDER BY submitted_at
      LIMIT $1
    `,
    [limit]
  );
  return result.rows;
}

export async function markCashSweepSubmitted(
  db: Queryable,
  id: string,
  signature: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await db.query(
    `
      UPDATE billing_cash_sweep_requests
      SET status = 'submitted', transaction_signature = $2,
          metadata = metadata || $3::jsonb, submitted_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'processing'
    `,
    [id, signature, JSON.stringify(metadata)]
  );
}

export async function markCashSweepFailed(db: Queryable, id: string, reason: string): Promise<void> {
  await db.query(
    `
      UPDATE billing_cash_sweep_requests
      SET status = 'failed', attempt_count = attempt_count + 1,
          next_attempt_at = now() + (LEAST(3600, 15 * power(2, LEAST(attempt_count, 8)))::text || ' seconds')::interval,
          failure_reason = $2, updated_at = now()
      WHERE id = $1 AND status IN ('processing', 'submitted')
    `,
    [id, reason.slice(0, 1000)]
  );
}

export async function markCashSweepConfirmed(db: Queryable, id: string): Promise<void> {
  await db.query(
    `
      UPDATE billing_cash_sweep_requests
      SET status = 'confirmed', confirmed_at = now(), failure_reason = NULL, updated_at = now()
      WHERE id = $1 AND status = 'submitted'
    `,
    [id]
  );
}

export async function listWithdrawalRequests(
  db: Queryable,
  accountId: string,
  limit = 20
): Promise<WithdrawalRequestRow[]> {
  const result = await db.query<WithdrawalRequestRow>(
    `
      SELECT
        id, status, amount_minor::text::int AS "amountMinor", currency,
        token_symbol AS "tokenSymbol", token_mint AS "tokenMint",
        token_amount_base_units::text AS "tokenAmountBaseUnits",
        destination_address AS "destinationAddress", eligible_at AS "eligibleAt",
        transaction_signature AS "transactionSignature", failure_reason AS "failureReason",
        requested_at AS "requestedAt", submitted_at AS "submittedAt", confirmed_at AS "confirmedAt"
      FROM withdrawal_requests
      WHERE account_id = $1
      ORDER BY requested_at DESC
      LIMIT $2
    `,
    [accountId, limit]
  );
  return result.rows;
}

export async function findWithdrawalForUpdate(
  db: Queryable,
  accountId: string,
  withdrawalId: string
): Promise<WithdrawalRequestRow | null> {
  const result = await db.query<WithdrawalRequestRow>(
    `
      SELECT
        id, status, amount_minor::text::int AS "amountMinor", currency,
        token_symbol AS "tokenSymbol", token_mint AS "tokenMint",
        token_amount_base_units::text AS "tokenAmountBaseUnits",
        destination_address AS "destinationAddress", eligible_at AS "eligibleAt",
        transaction_signature AS "transactionSignature", failure_reason AS "failureReason",
        requested_at AS "requestedAt", submitted_at AS "submittedAt", confirmed_at AS "confirmedAt"
      FROM withdrawal_requests
      WHERE account_id = $1 AND id = $2
      FOR UPDATE
    `,
    [accountId, withdrawalId]
  );
  return result.rows[0] ?? null;
}

export async function cancelWithdrawalRequest(db: Queryable, withdrawalId: string): Promise<void> {
  await db.query(
    `
      UPDATE withdrawal_requests
      SET status = 'cancelled', updated_at = now()
      WHERE id = $1
    `,
    [withdrawalId]
  );
}

export async function advanceWithdrawalCooldowns(db: Queryable): Promise<void> {
  await db.query(
    `
      UPDATE withdrawal_requests
      SET eligible_at = now() + (billing_plan_versions.withdrawal_cooldown_seconds::text || ' seconds')::interval,
          updated_at = now()
      FROM billing_account_plan_assignments
      JOIN billing_plan_versions ON billing_plan_versions.id = billing_account_plan_assignments.plan_version_id
      WHERE withdrawal_requests.account_id = billing_account_plan_assignments.account_id
        AND billing_account_plan_assignments.ends_at IS NULL
        AND withdrawal_requests.status IN ('cooldown', 'ready')
        AND EXISTS (
          SELECT 1
          FROM sessions
          JOIN session_status ON session_status.session_id = sessions.id
          WHERE sessions.account_id = withdrawal_requests.account_id
            AND sessions.desired_state <> 'Revoked'
            AND session_status.phase NOT IN ('revoked', 'failed')
        )
    `
  );
  await db.query(
    `
      UPDATE withdrawal_requests
      SET status = 'ready', updated_at = now()
      WHERE status IN ('cooldown', 'failed')
        AND eligible_at <= now()
        AND updated_at < now() - interval '1 minute'
        AND NOT EXISTS (
          SELECT 1
          FROM sessions
          JOIN session_status ON session_status.session_id = sessions.id
          WHERE sessions.account_id = withdrawal_requests.account_id
            AND sessions.desired_state <> 'Revoked'
            AND session_status.phase NOT IN ('revoked', 'failed')
        )
    `
  );
}

export async function claimReadyWithdrawal(db: Queryable): Promise<ClaimedWithdrawalRow | null> {
  const result = await db.query<ClaimedWithdrawalRow>(
    `
      WITH candidate AS (
        SELECT id
        FROM withdrawal_requests
        WHERE status = 'ready'
        ORDER BY eligible_at, requested_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE withdrawal_requests
      SET status = 'processing', failure_reason = NULL, updated_at = now()
      FROM candidate
      WHERE withdrawal_requests.id = candidate.id
      RETURNING
        withdrawal_requests.id,
        withdrawal_requests.account_id AS "accountId",
        withdrawal_requests.status,
        withdrawal_requests.amount_minor::text::int AS "amountMinor",
        withdrawal_requests.currency,
        withdrawal_requests.token_symbol AS "tokenSymbol",
        withdrawal_requests.token_mint AS "tokenMint",
        withdrawal_requests.token_amount_base_units::text AS "tokenAmountBaseUnits",
        withdrawal_requests.destination_address AS "destinationAddress",
        withdrawal_requests.eligible_at AS "eligibleAt",
        withdrawal_requests.transaction_signature AS "transactionSignature",
        withdrawal_requests.failure_reason AS "failureReason",
        withdrawal_requests.requested_at AS "requestedAt",
        withdrawal_requests.submitted_at AS "submittedAt",
        withdrawal_requests.confirmed_at AS "confirmedAt"
    `
  );
  return result.rows[0] ?? null;
}

export async function markWithdrawalSubmitted(
  db: Queryable,
  withdrawalId: string,
  transactionSignature: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await db.query(
    `
      UPDATE withdrawal_requests
      SET status = 'submitted',
          transaction_signature = $2,
          metadata = metadata || $3::jsonb,
          submitted_at = now(),
          updated_at = now()
      WHERE id = $1 AND status = 'processing'
    `,
    [withdrawalId, transactionSignature, JSON.stringify(metadata)]
  );
}

export async function markWithdrawalFailed(db: Queryable, withdrawalId: string, error: string): Promise<void> {
  await db.query(
    `
      UPDATE withdrawal_requests
      SET status = 'failed', failure_reason = $2, updated_at = now()
      WHERE id = $1 AND status IN ('processing', 'submitted')
    `,
    [withdrawalId, error.slice(0, 2000)]
  );
}

export async function listSubmittedWithdrawals(db: Queryable, limit = 100): Promise<ClaimedWithdrawalRow[]> {
  const result = await db.query<ClaimedWithdrawalRow>(
    `
      SELECT
        id, account_id AS "accountId", status, amount_minor::text::int AS "amountMinor", currency,
        token_symbol AS "tokenSymbol", token_mint AS "tokenMint",
        token_amount_base_units::text AS "tokenAmountBaseUnits",
        destination_address AS "destinationAddress", eligible_at AS "eligibleAt",
        transaction_signature AS "transactionSignature", failure_reason AS "failureReason",
        requested_at AS "requestedAt", submitted_at AS "submittedAt", confirmed_at AS "confirmedAt"
      FROM withdrawal_requests
      WHERE status = 'submitted' AND transaction_signature IS NOT NULL
      ORDER BY submitted_at
      LIMIT $1
    `,
    [limit]
  );
  return result.rows;
}

export async function markWithdrawalConfirmed(db: Queryable, withdrawalId: string): Promise<void> {
  await db.query(
    `UPDATE withdrawal_requests SET status = 'confirmed', confirmed_at = now(), updated_at = now() WHERE id = $1`,
    [withdrawalId]
  );
}

export async function listAccountUsageSummaries(
  db: Queryable,
  accountId: string,
  limit = 100
): Promise<AccountUsageSummaryRow[]> {
  const result = await db.query<AccountUsageSummaryRow>(
    `
      SELECT
        retail_usage_ratings.session_id AS "sessionId",
        sessions.label AS "sessionLabel",
        SUM(retail_usage_ratings.active_seconds)::text::int AS "activeSeconds",
        SUM(retail_usage_ratings.bytes_to_destination)::text AS "bytesToDestination",
        SUM(retail_usage_ratings.bytes_from_destination)::text AS "bytesFromDestination",
        SUM(retail_usage_ratings.posted_charge_minor)::text::int AS "chargeMinor",
        SUM(retail_usage_ratings.charge_microminor)::text AS "estimatedChargeMicrominor",
        MAX(retail_usage_ratings.window_end) AS "lastRatedAt"
      FROM retail_usage_ratings
      JOIN sessions ON sessions.id = retail_usage_ratings.session_id
      WHERE retail_usage_ratings.account_id = $1
      GROUP BY retail_usage_ratings.session_id, sessions.label
      ORDER BY MAX(retail_usage_ratings.window_end) DESC
      LIMIT $2
    `,
    [accountId, limit]
  );
  return result.rows;
}

export async function claimBillingNotification(db: Queryable): Promise<BillingNotificationRow | null> {
  const result = await db.query<BillingNotificationRow>(
    `
      WITH candidate AS (
        SELECT id
        FROM billing_notification_outbox
        WHERE (
          status IN ('pending', 'failed') AND next_attempt_at <= now()
        ) OR (
          status = 'sending' AND updated_at < now() - interval '10 minutes'
        )
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE billing_notification_outbox
      SET status = 'sending',
          attempt_count = attempt_count + 1,
          updated_at = now()
      FROM candidate
      WHERE billing_notification_outbox.id = candidate.id
      RETURNING
        billing_notification_outbox.id,
        billing_notification_outbox.account_id AS "accountId",
        billing_notification_outbox.notification_type AS "notificationType",
        billing_notification_outbox.recipient_email::text AS "recipientEmail",
        billing_notification_outbox.payload,
        billing_notification_outbox.attempt_count AS "attemptCount"
    `
  );
  return result.rows[0] ?? null;
}

export async function markBillingNotificationSent(db: Queryable, notificationId: string): Promise<void> {
  await db.query(
    `UPDATE billing_notification_outbox
     SET status = 'sent', sent_at = now(), last_error = NULL, updated_at = now()
     WHERE id = $1`,
    [notificationId]
  );
}

export async function markBillingNotificationFailed(
  db: Queryable,
  notificationId: string,
  error: string,
  retrySeconds: number
): Promise<void> {
  await db.query(
    `UPDATE billing_notification_outbox
     SET status = 'failed',
         last_error = $2,
         next_attempt_at = now() + ($3::text || ' seconds')::interval,
         updated_at = now()
     WHERE id = $1`,
    [notificationId, error.slice(0, 2000), retrySeconds]
  );
}
