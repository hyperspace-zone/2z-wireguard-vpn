-- Migration 0054: prebuild concurrently on busy deployments before migrations.
-- No billing or traffic history is changed.
CREATE INDEX IF NOT EXISTS users_active_account_created_idx
  ON users (account_id, created_at) WHERE disabled_at IS NULL;

CREATE INDEX IF NOT EXISTS gate_usage_egress_window_idx
  ON gate_assignment_usage_deltas (window_end, assignment_id) WHERE role = 'Egress';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid IN (to_regclass('users_active_account_created_idx'), to_regclass('gate_usage_egress_window_idx'))
      AND NOT indisvalid
  ) THEN
    RAISE EXCEPTION 'Invalid billing read index; inspect the concurrent build before continuing';
  END IF;
END $$;
