-- The DB-host history archiver builds these indexes CONCURRENTLY on an
-- existing fleet before migrations are applied. IF NOT EXISTS keeps a fresh
-- installation self-contained without making the migration runner special.
CREATE INDEX IF NOT EXISTS jobs_history_archive_idx
  ON jobs (updated_at, id)
  WHERE phase IN ('succeeded', 'dead');

CREATE INDEX IF NOT EXISTS gate_benchmark_results_created_history_archive_idx
  ON gate_benchmark_results (created_at, id);

-- PostgreSQL does not automatically index the referencing side of this
-- foreign key. The archiver needs it before old parent jobs can be removed.
CREATE INDEX IF NOT EXISTS gate_benchmark_results_job_id_idx
  ON gate_benchmark_results (job_id)
  WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS gate_assignment_counter_samples_history_archive_idx
  ON gate_assignment_counter_samples (received_at, id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index
    WHERE indexrelid IN (
      'jobs_history_archive_idx'::regclass,
      'gate_benchmark_results_created_history_archive_idx'::regclass,
      'gate_benchmark_results_job_id_idx'::regclass,
      'gate_assignment_counter_samples_history_archive_idx'::regclass
    )
      AND NOT indisvalid
  ) THEN
    RAISE EXCEPTION 'History archive index is invalid; inspect the concurrent build before continuing';
  END IF;
END $$;
