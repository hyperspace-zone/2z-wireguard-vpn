CREATE TABLE gate_benchmark_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  source_gate_id uuid NOT NULL REFERENCES gates(id) ON DELETE CASCADE,
  target_gate_id uuid NOT NULL REFERENCES gates(id) ON DELETE CASCADE,
  transport text NOT NULL CHECK (transport IN ('public', 'doublezero')),
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  source_interface text,
  target_endpoint text,
  packet_count integer NOT NULL DEFAULT 0 CHECK (packet_count >= 0),
  packets_received integer NOT NULL DEFAULT 0 CHECK (packets_received >= 0),
  loss_percent numeric,
  rtt_min_ms numeric,
  rtt_p50_ms numeric,
  rtt_p95_ms numeric,
  rtt_max_ms numeric,
  jitter_ms numeric,
  forward_one_way_p50_ms numeric,
  forward_one_way_p95_ms numeric,
  reverse_one_way_p50_ms numeric,
  reverse_one_way_p95_ms numeric,
  samples jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code text,
  error_message text,
  measured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX gate_benchmark_results_latest_idx
  ON gate_benchmark_results (source_gate_id, target_gate_id, transport, measured_at DESC);

CREATE INDEX gate_benchmark_results_created_idx
  ON gate_benchmark_results (created_at DESC);
