CREATE TABLE custodial_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chain text NOT NULL,
  public_key text NOT NULL,
  encrypted_key jsonb NOT NULL,
  key_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, chain),
  UNIQUE (chain, public_key)
);

CREATE UNIQUE INDEX topup_intents_transaction_signature_unique_idx
  ON topup_intents (transaction_signature)
  WHERE transaction_signature IS NOT NULL;

CREATE INDEX topup_intents_submitted_idx
  ON topup_intents (updated_at)
  WHERE status = 'submitted';
