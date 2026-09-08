-- Archive child history by its own immutable completion/insertion time. This
-- avoids multi-million-row parent/child scans on busy databases.
CREATE INDEX IF NOT EXISTS job_attempts_completed_history_archive_idx
  ON job_attempts (completed_at, id)
  WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS trading_probe_job_attempts_completed_history_archive_idx
  ON trading_probe_job_attempts (completed_at, id)
  WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS gate_assignment_usage_deltas_history_archive_idx
  ON gate_assignment_usage_deltas (created_at, sample_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index
    WHERE indexrelid IN (
      'job_attempts_completed_history_archive_idx'::regclass,
      'trading_probe_job_attempts_completed_history_archive_idx'::regclass,
      'gate_assignment_usage_deltas_history_archive_idx'::regclass
    )
      AND NOT indisvalid
  ) THEN
    RAISE EXCEPTION 'Direct-time history archive index is invalid; inspect the concurrent build before continuing';
  END IF;
END $$;
