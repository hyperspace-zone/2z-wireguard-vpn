CREATE INDEX IF NOT EXISTS gate_benchmark_results_measured_route_idx
  ON gate_benchmark_results (measured_at DESC, source_gate_id, target_gate_id);
