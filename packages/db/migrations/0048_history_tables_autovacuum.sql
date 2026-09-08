-- High-volume synthetic and usage history is archived in small DELETE
-- batches. Keep dead tuples reusable promptly without a blocking manual
-- compaction or routine repack.
ALTER TABLE gate_benchmark_results SET (
  autovacuum_vacuum_threshold = 10000,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_insert_threshold = 10000,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_analyze_threshold = 5000,
  autovacuum_analyze_scale_factor = 0.005
);

ALTER TABLE job_attempts SET (
  autovacuum_vacuum_threshold = 10000,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_insert_threshold = 10000,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_analyze_threshold = 5000,
  autovacuum_analyze_scale_factor = 0.005
);

ALTER TABLE trading_probe_jobs SET (
  autovacuum_vacuum_threshold = 10000,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_insert_threshold = 10000,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_analyze_threshold = 5000,
  autovacuum_analyze_scale_factor = 0.005
);

ALTER TABLE trading_probe_job_attempts SET (
  autovacuum_vacuum_threshold = 10000,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_insert_threshold = 10000,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_analyze_threshold = 5000,
  autovacuum_analyze_scale_factor = 0.005
);

ALTER TABLE trading_latency_rollups SET (
  autovacuum_vacuum_threshold = 10000,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_insert_threshold = 10000,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_analyze_threshold = 5000,
  autovacuum_analyze_scale_factor = 0.005
);

ALTER TABLE gate_assignment_counter_samples SET (
  autovacuum_vacuum_threshold = 10000,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_insert_threshold = 10000,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_analyze_threshold = 5000,
  autovacuum_analyze_scale_factor = 0.005
);

ALTER TABLE gate_assignment_usage_deltas SET (
  autovacuum_vacuum_threshold = 10000,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_insert_threshold = 10000,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_analyze_threshold = 5000,
  autovacuum_analyze_scale_factor = 0.005
);
