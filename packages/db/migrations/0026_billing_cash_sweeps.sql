CREATE TABLE billing_cash_sweep_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES billing_accounts(account_id) ON DELETE CASCADE,
  source_type text NOT NULL,
  source_id text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL DEFAULT 'USD',
  token_symbol text NOT NULL,
  token_mint text NOT NULL,
  token_amount_base_units bigint NOT NULL CHECK (token_amount_base_units > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'submitted', 'confirmed', 'failed', 'cancelled')
  ),
  transaction_signature text,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  failure_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  confirmed_at timestamptz,
  UNIQUE (source_type, source_id)
);

CREATE UNIQUE INDEX billing_cash_sweep_requests_signature_idx
  ON billing_cash_sweep_requests (transaction_signature)
  WHERE transaction_signature IS NOT NULL;

CREATE INDEX billing_cash_sweep_requests_ready_idx
  ON billing_cash_sweep_requests (next_attempt_at, created_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX billing_cash_sweep_requests_submitted_idx
  ON billing_cash_sweep_requests (submitted_at)
  WHERE status = 'submitted';
