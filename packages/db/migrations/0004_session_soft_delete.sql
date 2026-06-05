ALTER TABLE sessions
  ADD COLUMN hidden_at timestamptz;

CREATE INDEX sessions_account_visible_created_idx ON sessions (account_id, created_at DESC)
  WHERE hidden_at IS NULL;
