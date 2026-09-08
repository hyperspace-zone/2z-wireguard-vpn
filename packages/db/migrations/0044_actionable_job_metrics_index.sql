-- Prebuild CONCURRENTLY on existing fleets with
-- scripts/control-plane/prebuild-active-job-metrics-index.mjs.
-- Successful history remains in jobs but is not polled by operational metrics.
CREATE INDEX IF NOT EXISTS jobs_actionable_metrics_idx ON jobs (type, phase)
  WHERE phase <> 'succeeded';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_index
    WHERE indexrelid = 'jobs_actionable_metrics_idx'::regclass AND NOT indisvalid)
  THEN
    RAISE EXCEPTION 'Actionable jobs index is invalid; inspect the concurrent build';
  END IF;
END $$;
