ALTER TABLE identities
  ADD COLUMN IF NOT EXISTS email citext,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

CREATE INDEX IF NOT EXISTS identities_account_provider_idx
  ON identities (account_id, provider);

CREATE TABLE email_login_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL,
  code_hash text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX email_login_challenges_active_idx
  ON email_login_challenges (email, created_at DESC)
  WHERE consumed_at IS NULL;

CREATE TABLE oauth_login_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  state_hash text NOT NULL UNIQUE,
  redirect_after text NOT NULL DEFAULT '/',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX oauth_login_challenges_provider_active_idx
  ON oauth_login_challenges (provider, created_at DESC)
  WHERE consumed_at IS NULL;

CREATE TABLE wallet_link_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain text NOT NULL,
  public_key text NOT NULL,
  nonce_hash text NOT NULL,
  message text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX wallet_link_challenges_active_idx
  ON wallet_link_challenges (account_id, chain, public_key, created_at DESC)
  WHERE consumed_at IS NULL;

CREATE TABLE wallet_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  chain text NOT NULL,
  public_key text NOT NULL,
  label text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  linked_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE UNIQUE INDEX wallet_links_chain_public_key_active_idx
  ON wallet_links (chain, public_key)
  WHERE revoked_at IS NULL;

CREATE INDEX wallet_links_account_active_idx
  ON wallet_links (account_id, chain, linked_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE billing_accounts (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  currency text NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE balance_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  entry_type text NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  source_type text NOT NULL,
  source_id text NOT NULL,
  description text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX balance_ledger_entries_source_idx
  ON balance_ledger_entries (source_type, source_id);

CREATE INDEX balance_ledger_entries_account_created_idx
  ON balance_ledger_entries (account_id, created_at DESC);

CREATE TABLE topup_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  status text NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  chain text,
  token_symbol text,
  token_mint text,
  treasury_address text,
  reference text NOT NULL,
  expected_sender text,
  transaction_signature text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  submitted_at timestamptz,
  confirmed_at timestamptz
);

CREATE UNIQUE INDEX topup_intents_reference_idx ON topup_intents (reference);
CREATE INDEX topup_intents_account_created_idx ON topup_intents (account_id, created_at DESC);

CREATE TABLE doublezero_tenant_billing_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster text NOT NULL,
  tenant text NOT NULL,
  payment_status text,
  token_account text,
  billing_rate text,
  last_deduction_dz_epoch bigint,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX doublezero_tenant_billing_snapshots_latest_idx
  ON doublezero_tenant_billing_snapshots (cluster, tenant, observed_at DESC);
