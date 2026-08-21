CREATE TABLE solana_payment_receipts (
  transaction_signature text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES billing_accounts(account_id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type = 'direct_deposit'),
  source_id text NOT NULL,
  token_mint text,
  amount_base_units bigint CHECK (amount_base_units IS NULL OR amount_base_units > 0),
  credited_amount_minor bigint NOT NULL DEFAULT 0 CHECK (credited_amount_minor >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id)
);

CREATE TABLE solana_deposit_scan_cursors (
  wallet_id uuid NOT NULL REFERENCES custodial_wallets(id) ON DELETE CASCADE,
  token_mint text NOT NULL,
  token_accounts jsonb NOT NULL DEFAULT '[]'::jsonb,
  latest_signatures jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_scan_at timestamptz NOT NULL DEFAULT now(),
  last_scanned_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_id, token_mint)
);

CREATE INDEX solana_deposit_scan_cursors_due_idx
  ON solana_deposit_scan_cursors (next_scan_at, wallet_id);

CREATE TABLE solana_deposit_remainders (
  account_id uuid NOT NULL REFERENCES billing_accounts(account_id) ON DELETE CASCADE,
  token_mint text NOT NULL,
  remainder_base_units bigint NOT NULL DEFAULT 0 CHECK (remainder_base_units >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, token_mint)
);
