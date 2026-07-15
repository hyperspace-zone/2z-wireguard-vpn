CREATE TABLE gate_assignment_counter_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_id uuid NOT NULL REFERENCES gates(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES gate_assignments(id) ON DELETE CASCADE,
  boot_id text NOT NULL,
  generation integer NOT NULL,
  role text NOT NULL,
  sampled_at timestamptz NOT NULL,
  wireguard_client_receive_bytes bigint NOT NULL DEFAULT 0,
  wireguard_client_transmit_bytes bigint NOT NULL DEFAULT 0,
  wireguard_transit_receive_bytes bigint NOT NULL DEFAULT 0,
  wireguard_transit_transmit_bytes bigint NOT NULL DEFAULT 0,
  forwarded_to_destination_packets bigint NOT NULL DEFAULT 0,
  forwarded_to_destination_bytes bigint NOT NULL DEFAULT 0,
  forwarded_from_destination_packets bigint NOT NULL DEFAULT 0,
  forwarded_from_destination_bytes bigint NOT NULL DEFAULT 0,
  dropped_to_destination_packets bigint NOT NULL DEFAULT 0,
  dropped_to_destination_bytes bigint NOT NULL DEFAULT 0,
  dropped_from_destination_packets bigint NOT NULL DEFAULT 0,
  dropped_from_destination_bytes bigint NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gate_id, assignment_id, boot_id, generation, sampled_at)
);

CREATE INDEX gate_assignment_counter_samples_assignment_time_idx
  ON gate_assignment_counter_samples (assignment_id, sampled_at DESC);

CREATE TABLE gate_assignment_usage_deltas (
  sample_id uuid PRIMARY KEY REFERENCES gate_assignment_counter_samples(id) ON DELETE CASCADE,
  gate_id uuid NOT NULL REFERENCES gates(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES gate_assignments(id) ON DELETE CASCADE,
  boot_id text NOT NULL,
  generation integer NOT NULL,
  role text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  wireguard_client_receive_bytes bigint NOT NULL DEFAULT 0,
  wireguard_client_transmit_bytes bigint NOT NULL DEFAULT 0,
  wireguard_transit_receive_bytes bigint NOT NULL DEFAULT 0,
  wireguard_transit_transmit_bytes bigint NOT NULL DEFAULT 0,
  forwarded_to_destination_packets bigint NOT NULL DEFAULT 0,
  forwarded_to_destination_bytes bigint NOT NULL DEFAULT 0,
  forwarded_from_destination_packets bigint NOT NULL DEFAULT 0,
  forwarded_from_destination_bytes bigint NOT NULL DEFAULT 0,
  dropped_to_destination_packets bigint NOT NULL DEFAULT 0,
  dropped_to_destination_bytes bigint NOT NULL DEFAULT 0,
  dropped_from_destination_packets bigint NOT NULL DEFAULT 0,
  dropped_from_destination_bytes bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX gate_assignment_usage_deltas_assignment_window_idx
  ON gate_assignment_usage_deltas (assignment_id, window_end DESC);

CREATE INDEX gate_assignment_usage_deltas_gate_window_idx
  ON gate_assignment_usage_deltas (gate_id, window_end DESC);
