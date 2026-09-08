-- Terminal trading jobs should normally finalize their attempt in the same
-- transaction. Keep the exceptional/incomplete subset cheap to reconcile and
-- inspect without scanning the high-volume completed attempt history.
CREATE INDEX IF NOT EXISTS trading_probe_job_attempts_incomplete_job_idx
  ON trading_probe_job_attempts (job_id)
  WHERE completed_at IS NULL;

