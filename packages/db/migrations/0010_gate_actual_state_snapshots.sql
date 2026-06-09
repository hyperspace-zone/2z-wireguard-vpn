CREATE TABLE IF NOT EXISTS gate_actual_state_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_id uuid NOT NULL REFERENCES gates(id) ON DELETE CASCADE,
  boot_id text,
  agent_version text,
  state_hash text NOT NULL,
  managed_handles text[] NOT NULL DEFAULT '{}',
  capabilities text[] NOT NULL DEFAULT '{}',
  diagnostic_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  reported_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gate_actual_state_snapshots_gate_received_idx
  ON gate_actual_state_snapshots (gate_id, received_at DESC);
