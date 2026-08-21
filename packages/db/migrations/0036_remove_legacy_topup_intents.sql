DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM solana_payment_receipts
    WHERE source_type <> 'direct_deposit'
  ) THEN
    RAISE EXCEPTION
      'cannot remove legacy top-up intents while non-direct-deposit receipts remain';
  END IF;
END
$$;

ALTER TABLE solana_payment_receipts
  DROP CONSTRAINT IF EXISTS solana_payment_receipts_source_type_check;

ALTER TABLE solana_payment_receipts
  ADD CONSTRAINT solana_payment_receipts_source_type_check
  CHECK (source_type = 'direct_deposit');

DROP TABLE IF EXISTS topup_intents;
