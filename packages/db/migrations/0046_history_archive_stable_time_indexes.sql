-- Migration 0045 was canaried in staging with event timestamps. Archive by
-- insertion timestamps instead: a delayed gate report can contain an old
-- measured_at/sampled_at value, while created_at/received_at cannot move a new
-- row into an already published UTC archive slice.
CREATE INDEX IF NOT EXISTS gate_benchmark_results_created_history_archive_idx
  ON gate_benchmark_results (created_at, id);

DROP INDEX IF EXISTS gate_benchmark_results_history_archive_idx;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'gate_assignment_counter_samples_history_archive_idx'
      AND indexdef NOT LIKE '%(received_at, id)%'
  ) THEN
    DROP INDEX gate_assignment_counter_samples_history_archive_idx;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS gate_assignment_counter_samples_history_archive_idx
  ON gate_assignment_counter_samples (received_at, id);
