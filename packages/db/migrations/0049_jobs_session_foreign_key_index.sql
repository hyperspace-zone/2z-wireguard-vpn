-- Most synthetic jobs do not belong to a user session. Index only the small
-- referencing subset so session deletion and FK checks never scan the full
-- operational job history.
CREATE INDEX IF NOT EXISTS jobs_session_id_idx
  ON jobs (session_id)
  WHERE session_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index
    WHERE indexrelid = 'jobs_session_id_idx'::regclass
      AND NOT indisvalid
  ) THEN
    RAISE EXCEPTION 'jobs_session_id_idx is invalid; inspect its concurrent build before continuing';
  END IF;
END $$;
