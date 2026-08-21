ALTER TABLE solana_deposit_scan_cursors
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  ADD COLUMN last_success_at timestamptz;

UPDATE solana_deposit_scan_cursors
SET last_success_at = last_scanned_at
WHERE last_error IS NULL
  AND last_scanned_at IS NOT NULL;
