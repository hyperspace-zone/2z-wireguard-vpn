-- Raw usage is append-only. Maintain an exact, transactional read model instead
-- of aggregating millions of deltas on every Admin navigation. The trigger lock
-- remains held through the backfill, so concurrent inserts cannot be missed or
-- counted twice. No raw counters, entitlements, or payment history are changed.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX IF NOT EXISTS accounts_recent_created_idx ON accounts (created_at DESC, id);

CREATE TABLE gate_assignment_usage_totals (
  assignment_id uuid PRIMARY KEY REFERENCES gate_assignments(id) ON DELETE CASCADE,
  bytes_to_destination numeric NOT NULL DEFAULT 0,
  bytes_from_destination numeric NOT NULL DEFAULT 0,
  dropped_bytes numeric NOT NULL DEFAULT 0,
  first_traffic_at timestamptz NOT NULL,
  last_traffic_at timestamptz NOT NULL
);

CREATE FUNCTION accumulate_gate_assignment_usage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'Egress' THEN
    INSERT INTO gate_assignment_usage_totals (
      assignment_id, bytes_to_destination, bytes_from_destination, dropped_bytes,
      first_traffic_at, last_traffic_at
    ) VALUES (
      NEW.assignment_id, NEW.forwarded_to_destination_bytes, NEW.forwarded_from_destination_bytes,
      NEW.dropped_to_destination_bytes::numeric + NEW.dropped_from_destination_bytes,
      NEW.window_start, NEW.window_end
    ) ON CONFLICT (assignment_id) DO UPDATE SET
      bytes_to_destination = gate_assignment_usage_totals.bytes_to_destination + EXCLUDED.bytes_to_destination,
      bytes_from_destination = gate_assignment_usage_totals.bytes_from_destination + EXCLUDED.bytes_from_destination,
      dropped_bytes = gate_assignment_usage_totals.dropped_bytes + EXCLUDED.dropped_bytes,
      first_traffic_at = LEAST(gate_assignment_usage_totals.first_traffic_at, EXCLUDED.first_traffic_at),
      last_traffic_at = GREATEST(gate_assignment_usage_totals.last_traffic_at, EXCLUDED.last_traffic_at);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER gate_assignment_usage_totals_insert
  AFTER INSERT ON gate_assignment_usage_deltas
  FOR EACH ROW EXECUTE FUNCTION accumulate_gate_assignment_usage();

INSERT INTO gate_assignment_usage_totals (
  assignment_id, bytes_to_destination, bytes_from_destination, dropped_bytes,
  first_traffic_at, last_traffic_at
)
SELECT assignment_id, SUM(forwarded_to_destination_bytes), SUM(forwarded_from_destination_bytes),
  SUM(dropped_to_destination_bytes::numeric + dropped_from_destination_bytes), MIN(window_start), MAX(window_end)
FROM gate_assignment_usage_deltas WHERE role = 'Egress' GROUP BY assignment_id;
