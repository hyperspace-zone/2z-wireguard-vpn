-- Prebuild CONCURRENTLY on existing fleets before applying migrations:
-- scripts/control-plane/prebuild-metrics-indexes.mjs. Fresh DBs are empty.
CREATE INDEX IF NOT EXISTS jobs_metrics_type_phase_idx ON jobs (type, phase);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = 'jobs_metrics_type_phase_idx'::regclass AND NOT indisvalid
  ) THEN
    RAISE EXCEPTION 'Job metrics index is invalid; inspect the concurrent build before continuing';
  END IF;
END $$;
