-- This journal belongs only to probes PostgreSQL, never to the financial DB.
CREATE TABLE IF NOT EXISTS measurement_delivery_outbox (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('benchmark','trading')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS measurement_delivery_due_idx
  ON measurement_delivery_outbox(next_attempt_at,created_at);
-- Scheduler state, not a second copy of measurement values.
CREATE TABLE IF NOT EXISTS probe_measurement_schedule (
  kind text NOT NULL,
  source_id uuid NOT NULL,
  target_id uuid NOT NULL,
  network_profile text NOT NULL,
  target_revision integer NOT NULL DEFAULT 0,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(kind,source_id,target_id,network_profile)
);
