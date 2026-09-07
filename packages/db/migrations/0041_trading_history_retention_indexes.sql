-- On an existing large fleet, prebuild these exact indexes CONCURRENTLY
-- before running migrations. IF NOT EXISTS then records the migration without
-- blocking probe reporting for an index build. Fresh installations are empty.
CREATE INDEX IF NOT EXISTS trading_probe_jobs_retention_idx
  ON trading_probe_jobs (updated_at, id)
  WHERE phase IN ('succeeded', 'failed', 'dead');

CREATE INDEX IF NOT EXISTS trading_latency_rollups_retention_idx
  ON trading_latency_rollups (bucket_start, id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid IN ('trading_probe_jobs_retention_idx'::regclass,
                         'trading_latency_rollups_retention_idx'::regclass)
      AND NOT indisvalid
  ) THEN
    RAISE EXCEPTION 'Trading retention index is invalid; inspect the concurrent build before continuing';
  END IF;
END $$;
