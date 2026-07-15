CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  granted_by text NOT NULL DEFAULT 'operator',
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE INDEX user_roles_role_idx ON user_roles (role, user_id);

CREATE TABLE billing_plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  display_name text NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  active_config_monthly_minor bigint NOT NULL DEFAULT 0 CHECK (active_config_monthly_minor >= 0),
  traffic_per_gb_minor bigint NOT NULL DEFAULT 0 CHECK (traffic_per_gb_minor >= 0),
  grace_period_seconds integer NOT NULL DEFAULT 86400 CHECK (grace_period_seconds >= 0),
  withdrawal_cooldown_seconds integer NOT NULL DEFAULT 86400 CHECK (withdrawal_cooldown_seconds >= 0),
  minimum_withdrawal_minor bigint NOT NULL DEFAULT 100 CHECK (minimum_withdrawal_minor >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (code, version)
);

INSERT INTO billing_plan_versions (
  code,
  version,
  display_name,
  active_config_monthly_minor,
  traffic_per_gb_minor,
  grace_period_seconds,
  withdrawal_cooldown_seconds,
  metadata
)
VALUES (
  'pilot',
  1,
  'Pilot',
  0,
  0,
  86400,
  86400,
  '{"purpose":"safe default; no automatic charges until an operator assigns a priced plan"}'::jsonb
);

INSERT INTO billing_accounts (account_id, currency)
SELECT accounts.id, 'USD'
FROM accounts
ON CONFLICT (account_id) DO NOTHING;

CREATE TABLE billing_account_plan_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES billing_accounts(account_id) ON DELETE CASCADE,
  plan_version_id uuid NOT NULL REFERENCES billing_plan_versions(id),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  assigned_by text NOT NULL DEFAULT 'system',
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE UNIQUE INDEX billing_account_plan_assignments_one_open_idx
  ON billing_account_plan_assignments (account_id)
  WHERE ends_at IS NULL;

CREATE INDEX billing_account_plan_assignments_history_idx
  ON billing_account_plan_assignments (account_id, starts_at DESC);

INSERT INTO billing_account_plan_assignments (
  account_id,
  plan_version_id,
  starts_at,
  assigned_by,
  reason
)
SELECT
  billing_accounts.account_id,
  billing_plan_versions.id,
  now(),
  'migration-0025',
  'Initial non-charging pilot plan'
FROM billing_accounts
CROSS JOIN billing_plan_versions
WHERE billing_plan_versions.code = 'pilot'
  AND billing_plan_versions.version = 1
ON CONFLICT (account_id) WHERE ends_at IS NULL DO NOTHING;

CREATE TABLE billing_balance_buckets (
  account_id uuid PRIMARY KEY REFERENCES billing_accounts(account_id) ON DELETE CASCADE,
  cash_minor bigint NOT NULL DEFAULT 0 CHECK (cash_minor >= 0),
  promotional_minor bigint NOT NULL DEFAULT 0 CHECK (promotional_minor >= 0),
  reserved_withdrawal_minor bigint NOT NULL DEFAULT 0 CHECK (reserved_withdrawal_minor >= 0),
  debt_minor bigint NOT NULL DEFAULT 0 CHECK (debt_minor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reserved_withdrawal_minor <= cash_minor)
);

WITH totals AS (
  SELECT
    billing_accounts.account_id,
    COALESCE(SUM(balance_ledger_entries.amount_minor) FILTER (
      WHERE balance_ledger_entries.amount_minor > 0
        AND balance_ledger_entries.entry_type = 'topup'
    ), 0)::bigint AS topups,
    COALESCE(SUM(balance_ledger_entries.amount_minor) FILTER (
      WHERE balance_ledger_entries.amount_minor > 0
        AND balance_ledger_entries.entry_type <> 'topup'
    ), 0)::bigint AS promotional,
    ABS(LEAST(COALESCE(SUM(balance_ledger_entries.amount_minor) FILTER (
      WHERE balance_ledger_entries.amount_minor < 0
    ), 0), 0))::bigint AS debits
  FROM billing_accounts
  LEFT JOIN balance_ledger_entries
    ON balance_ledger_entries.account_id = billing_accounts.account_id
  GROUP BY billing_accounts.account_id
)
INSERT INTO billing_balance_buckets (
  account_id,
  cash_minor,
  promotional_minor,
  debt_minor
)
SELECT
  account_id,
  GREATEST(topups - GREATEST(debits - promotional, 0), 0),
  GREATEST(promotional - debits, 0),
  GREATEST(debits - promotional - topups, 0)
FROM totals;

CREATE TABLE billing_account_accruals (
  account_id uuid PRIMARY KEY REFERENCES billing_accounts(account_id) ON DELETE CASCADE,
  microminor_remainder bigint NOT NULL DEFAULT 0 CHECK (microminor_remainder >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO billing_account_accruals (account_id)
SELECT account_id FROM billing_accounts;

CREATE TABLE billing_account_states (
  account_id uuid PRIMARY KEY REFERENCES billing_accounts(account_id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'grace', 'suspended')),
  overdrawn_at timestamptz,
  suspension_due_at timestamptz,
  suspended_at timestamptz,
  withdrawal_eligible_at timestamptz,
  last_settled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO billing_account_states (account_id)
SELECT account_id FROM billing_accounts;

CREATE TABLE retail_usage_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES billing_accounts(account_id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  plan_version_id uuid NOT NULL REFERENCES billing_plan_versions(id),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  active_seconds integer NOT NULL DEFAULT 0 CHECK (active_seconds >= 0),
  bytes_to_destination bigint NOT NULL DEFAULT 0 CHECK (bytes_to_destination >= 0),
  bytes_from_destination bigint NOT NULL DEFAULT 0 CHECK (bytes_from_destination >= 0),
  charge_microminor bigint NOT NULL DEFAULT 0 CHECK (charge_microminor >= 0),
  posted_charge_minor bigint NOT NULL DEFAULT 0 CHECK (posted_charge_minor >= 0),
  mode text NOT NULL CHECK (mode IN ('shadow', 'enforce')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end > window_start),
  UNIQUE (session_id, window_start, window_end)
);

CREATE INDEX retail_usage_ratings_account_window_idx
  ON retail_usage_ratings (account_id, window_end DESC);

CREATE INDEX retail_usage_ratings_session_window_idx
  ON retail_usage_ratings (session_id, window_end DESC);

CREATE TABLE billing_notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES billing_accounts(account_id) ON DELETE CASCADE,
  notification_type text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  recipient_email citext NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE INDEX billing_notification_outbox_pending_idx
  ON billing_notification_outbox (next_attempt_at, created_at)
  WHERE status IN ('pending', 'failed');

CREATE TABLE withdrawal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES billing_accounts(account_id) ON DELETE CASCADE,
  requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'cooldown' CHECK (
    status IN ('cooldown', 'ready', 'processing', 'submitted', 'confirmed', 'rejected', 'cancelled', 'failed')
  ),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL DEFAULT 'USD',
  chain text NOT NULL DEFAULT 'solana',
  token_symbol text NOT NULL,
  token_mint text NOT NULL,
  token_amount_base_units bigint NOT NULL CHECK (token_amount_base_units > 0),
  destination_address text NOT NULL,
  eligible_at timestamptz NOT NULL,
  transaction_signature text,
  failure_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  confirmed_at timestamptz
);

CREATE UNIQUE INDEX withdrawal_requests_transaction_signature_idx
  ON withdrawal_requests (transaction_signature)
  WHERE transaction_signature IS NOT NULL;

CREATE INDEX withdrawal_requests_account_created_idx
  ON withdrawal_requests (account_id, requested_at DESC);

CREATE INDEX withdrawal_requests_ready_idx
  ON withdrawal_requests (eligible_at, requested_at)
  WHERE status IN ('cooldown', 'ready', 'failed');

CREATE TABLE doublezero_tenant_cost_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster text NOT NULL,
  tenant text NOT NULL,
  dz_epoch bigint NOT NULL,
  token_symbol text NOT NULL DEFAULT '2Z',
  token_mint text NOT NULL,
  amount_base_units bigint NOT NULL CHECK (amount_base_units >= 0),
  usd_cost_minor bigint,
  quote jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_snapshot_id uuid REFERENCES doublezero_tenant_billing_snapshots(id) ON DELETE SET NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cluster, tenant, dz_epoch)
);

CREATE INDEX doublezero_tenant_cost_events_observed_idx
  ON doublezero_tenant_cost_events (cluster, tenant, observed_at DESC);

CREATE OR REPLACE FUNCTION initialize_prepaid_billing_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  pilot_plan_id uuid;
BEGIN
  INSERT INTO billing_accounts (account_id, currency)
  VALUES (NEW.id, 'USD')
  ON CONFLICT (account_id) DO NOTHING;

  SELECT id INTO pilot_plan_id
  FROM billing_plan_versions
  WHERE code = 'pilot' AND version = 1;

  INSERT INTO billing_account_plan_assignments (
    account_id, plan_version_id, assigned_by, reason
  ) VALUES (
    NEW.id, pilot_plan_id, 'account-trigger', 'Safe default plan'
  ) ON CONFLICT (account_id) WHERE ends_at IS NULL DO NOTHING;

  INSERT INTO billing_balance_buckets (account_id) VALUES (NEW.id)
  ON CONFLICT (account_id) DO NOTHING;
  INSERT INTO billing_account_accruals (account_id) VALUES (NEW.id)
  ON CONFLICT (account_id) DO NOTHING;
  INSERT INTO billing_account_states (account_id) VALUES (NEW.id)
  ON CONFLICT (account_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_initialize_prepaid_billing
AFTER INSERT ON accounts
FOR EACH ROW
EXECUTE FUNCTION initialize_prepaid_billing_account();
