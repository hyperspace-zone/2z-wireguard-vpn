ALTER TYPE session_phase ADD VALUE IF NOT EXISTS 'payment_pending' BEFORE 'requested';

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS create_request_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS sessions_account_create_request_unique_idx
  ON sessions (account_id, create_request_id)
  WHERE create_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS solana_config_payments (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  source_wallet_address text NOT NULL,
  treasury_address text NOT NULL,
  amount_lamports bigint NOT NULL CHECK (amount_lamports > 0),
  fee_lamports bigint CHECK (fee_lamports IS NULL OR fee_lamports >= 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'submitted', 'confirmed', 'failed')),
  transaction_signature text UNIQUE,
  raw_transaction bytea,
  recent_blockhash text,
  last_valid_block_height bigint,
  failure_code text,
  failure_reason text,
  processing_started_at timestamptz,
  submitted_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id)
);

CREATE INDEX IF NOT EXISTS solana_config_payments_account_created_idx
  ON solana_config_payments (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS solana_config_payments_recovery_idx
  ON solana_config_payments (status, updated_at)
  WHERE status IN ('processing', 'submitted');
