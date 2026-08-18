CREATE INDEX IF NOT EXISTS jobs_active_gate_ntp_discovery_idx
  ON jobs (gate_id)
  WHERE type = 'probe'
    AND phase IN ('queued', 'leased', 'running', 'retryable_failed')
    AND payload->>'kind' = 'gate_ntp_discovery_v1';

CREATE INDEX IF NOT EXISTS jobs_succeeded_gate_ntp_discovery_idx
  ON jobs (gate_id, id)
  WHERE type = 'probe'
    AND phase = 'succeeded'
    AND payload->>'kind' = 'gate_ntp_discovery_v1';
