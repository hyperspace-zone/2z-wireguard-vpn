CREATE INDEX solana_payment_receipts_account_observed_idx
  ON solana_payment_receipts (account_id, observed_at DESC, transaction_signature);
