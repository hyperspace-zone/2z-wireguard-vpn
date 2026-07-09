CREATE TABLE doublezero_usage_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster text NOT NULL,
  tenant text NOT NULL,
  import_source text NOT NULL,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX doublezero_usage_imports_latest_idx
  ON doublezero_usage_imports (cluster, tenant, imported_at DESC);

CREATE TABLE rated_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  provider text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  ingress_gate_name text,
  egress_gate_name text,
  bytes_in bigint NOT NULL DEFAULT 0,
  bytes_out bigint NOT NULL DEFAULT 0,
  cost_minor bigint NOT NULL,
  markup_bps integer NOT NULL,
  charge_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX rated_usage_events_source_idx
  ON rated_usage_events (source_type, source_id);

CREATE INDEX rated_usage_events_account_created_idx
  ON rated_usage_events (account_id, created_at DESC);

CREATE INDEX rated_usage_events_session_created_idx
  ON rated_usage_events (session_id, created_at DESC)
  WHERE session_id IS NOT NULL;
