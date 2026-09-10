ALTER TABLE solana_config_payments
  ADD COLUMN IF NOT EXISTS traffic_limit_bytes bigint
    CHECK (traffic_limit_bytes IS NULL OR traffic_limit_bytes > 0);

CREATE TABLE IF NOT EXISTS session_traffic_entitlements (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  included_bytes bigint NOT NULL CHECK (included_bytes > 0),
  consumed_bytes bigint NOT NULL DEFAULT 0 CHECK (consumed_bytes >= 0),
  exhausted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_traffic_entitlements_enforcement_idx
  ON session_traffic_entitlements (updated_at, session_id)
  WHERE exhausted_at IS NULL AND consumed_bytes >= included_bytes;
