CREATE INDEX IF NOT EXISTS gate_actual_state_snapshots_received_idx
  ON gate_actual_state_snapshots (received_at);

CREATE INDEX IF NOT EXISTS gate_benchmark_results_route_measured_idx
  ON gate_benchmark_results (source_gate_id, target_gate_id, measured_at DESC);

CREATE INDEX IF NOT EXISTS jobs_active_gate_benchmark_probe_idx
  ON jobs (gate_id, ((payload->>'targetGateId')))
  WHERE type = 'probe'
    AND phase IN ('queued', 'leased', 'running', 'retryable_failed')
    AND payload->>'kind' = 'gate_benchmark_v1';
