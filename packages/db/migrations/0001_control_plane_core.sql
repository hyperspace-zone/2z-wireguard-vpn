CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE gate_desired_state AS ENUM (
  'Enabled',
  'Draining',
  'Disabled',
  'Maintenance'
);

CREATE TYPE session_mode AS ENUM (
  'IpToIp',
  'FullTunnel'
);

CREATE TYPE session_desired_state AS ENUM (
  'Active',
  'Revoked'
);

CREATE TYPE session_phase AS ENUM (
  'requested',
  'probing',
  'scheduling',
  'provisioning',
  'active',
  'degraded',
  'revoking',
  'revoked',
  'failed'
);

CREATE TYPE gate_assignment_role AS ENUM (
  'Ingress',
  'Egress'
);

CREATE TYPE gate_assignment_desired_state AS ENUM (
  'Applied',
  'Revoked'
);

CREATE TYPE gate_assignment_phase AS ENUM (
  'planned',
  'queued',
  'leased',
  'applying',
  'applied',
  'drifted',
  'revoking',
  'revoked',
  'retryable_failed',
  'dead'
);

CREATE TYPE job_type AS ENUM (
  'probe',
  'apply_assignment',
  'revoke_assignment',
  'cleanup_orphan',
  'reconcile'
);

CREATE TYPE job_phase AS ENUM (
  'queued',
  'leased',
  'running',
  'succeeded',
  'retryable_failed',
  'dead'
);

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);

CREATE TABLE service_principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

CREATE TABLE gates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  generation bigint NOT NULL DEFAULT 1,
  desired_state gate_desired_state NOT NULL DEFAULT 'Disabled',
  identity text NOT NULL UNIQUE,
  region text NOT NULL,
  city text NOT NULL DEFAULT '',
  country text NOT NULL DEFAULT '',
  country_code text NOT NULL DEFAULT '',
  public_endpoint text NOT NULL,
  doublezero_interface text NOT NULL DEFAULT 'doublezero0',
  allowed_modes session_mode[] NOT NULL DEFAULT ARRAY['IpToIp', 'FullTunnel']::session_mode[],
  scheduling_weight integer NOT NULL DEFAULT 100,
  capacity_limit integer NOT NULL DEFAULT 0,
  required_agent_version text,
  spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gate_status (
  gate_id uuid PRIMARY KEY REFERENCES gates(id) ON DELETE CASCADE,
  observed_generation bigint NOT NULL DEFAULT 0,
  agent_version text,
  boot_id text,
  last_seen_at timestamptz,
  observed_endpoint text,
  observed_capabilities text[] NOT NULL DEFAULT '{}',
  capacity jsonb NOT NULL DEFAULT '{}'::jsonb,
  actual_state_hash text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gate_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_id uuid NOT NULL REFERENCES gates(id) ON DELETE CASCADE,
  type text NOT NULL,
  status text NOT NULL CHECK (status IN ('True', 'False', 'Unknown')),
  reason text NOT NULL,
  message text,
  observed_generation bigint,
  last_transition_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gate_id, type)
);

CREATE TABLE gate_leases (
  gate_id uuid PRIMARY KEY REFERENCES gates(id) ON DELETE CASCADE,
  lease_owner text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES accounts(id),
  generation bigint NOT NULL DEFAULT 1,
  desired_state session_desired_state NOT NULL DEFAULT 'Active',
  mode session_mode NOT NULL,
  destination_cidrs cidr[] NOT NULL DEFAULT '{}',
  client_key_mode text NOT NULL DEFAULT 'BringYourOwnPublicKey',
  path_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_account_created_idx ON sessions (account_id, created_at DESC);
CREATE UNIQUE INDEX sessions_idempotency_idx ON sessions (account_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE session_status (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  observed_generation bigint NOT NULL DEFAULT 0,
  phase session_phase NOT NULL DEFAULT 'requested',
  selected_path jsonb,
  artifact_id uuid,
  last_error jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE session_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type text NOT NULL,
  status text NOT NULL CHECK (status IN ('True', 'False', 'Unknown')),
  reason text NOT NULL,
  message text,
  observed_generation bigint,
  last_transition_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, type)
);

CREATE TABLE rendered_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  generation bigint NOT NULL,
  plan_hash text NOT NULL,
  public_material jsonb NOT NULL DEFAULT '{}'::jsonb,
  routing_model jsonb NOT NULL DEFAULT '{}'::jsonb,
  firewall_model jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, generation)
);

CREATE TABLE gate_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  gate_id uuid NOT NULL REFERENCES gates(id),
  role gate_assignment_role NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  desired_state gate_assignment_desired_state NOT NULL DEFAULT 'Applied',
  external_handle text NOT NULL UNIQUE,
  plan_id uuid NOT NULL REFERENCES rendered_plans(id),
  apply_timeout_seconds integer NOT NULL DEFAULT 120,
  revoke_timeout_seconds integer NOT NULL DEFAULT 120,
  reconcile_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, role)
);

CREATE TABLE gate_assignment_status (
  assignment_id uuid PRIMARY KEY REFERENCES gate_assignments(id) ON DELETE CASCADE,
  observed_generation bigint NOT NULL DEFAULT 0,
  phase gate_assignment_phase NOT NULL DEFAULT 'planned',
  applied_plan_id uuid REFERENCES rendered_plans(id),
  actual_state_hash text,
  applied_at timestamptz,
  revoked_at timestamptz,
  last_observed_at timestamptz,
  last_error jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gate_assignment_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES gate_assignments(id) ON DELETE CASCADE,
  type text NOT NULL,
  status text NOT NULL CHECK (status IN ('True', 'False', 'Unknown')),
  reason text NOT NULL,
  message text,
  observed_generation bigint,
  last_transition_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, type)
);

CREATE TABLE probe_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  target_cidrs cidr[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE probe_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  probe_run_id uuid NOT NULL REFERENCES probe_runs(id) ON DELETE CASCADE,
  gate_id uuid NOT NULL REFERENCES gates(id),
  target text NOT NULL,
  rtt_ms numeric,
  packet_loss_percent numeric,
  method text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  artifact_type text NOT NULL,
  phase text NOT NULL DEFAULT 'planned',
  encrypted_payload_ref text,
  key_fingerprints text[] NOT NULL DEFAULT '{}',
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  issued_at timestamptz,
  downloaded_at timestamptz,
  expires_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE session_status
  ADD CONSTRAINT session_status_artifact_fk
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type job_type NOT NULL,
  phase job_phase NOT NULL DEFAULT 'queued',
  gate_id uuid REFERENCES gates(id),
  session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  assignment_id uuid REFERENCES gate_assignments(id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  lease_owner text,
  lease_expires_at timestamptz,
  run_after timestamptz NOT NULL DEFAULT now(),
  retry_count integer NOT NULL DEFAULT 0,
  max_retries integer NOT NULL DEFAULT 5,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jobs_claim_idx ON jobs (phase, run_after, lease_expires_at);
CREATE INDEX jobs_gate_claim_idx ON jobs (gate_id, phase, run_after);

CREATE TABLE job_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  lease_owner text NOT NULL,
  leased_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  result_summary jsonb,
  error_code text,
  actual_state_hash text,
  UNIQUE (job_id, attempt_number)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES accounts(id),
  provider text NOT NULL,
  provider_payment_id text NOT NULL,
  status text NOT NULL,
  amount jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id)
);

CREATE TABLE agent_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES accounts(id),
  service_principal_id uuid REFERENCES service_principals(id),
  payment_id uuid REFERENCES payments(id),
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  purchased_duration_seconds integer NOT NULL,
  effective_expiry_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE idempotency_keys (
  key text PRIMARY KEY,
  subject_id uuid,
  request_hash text NOT NULL,
  response jsonb,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  actor_type text NOT NULL,
  actor_id uuid,
  account_id uuid REFERENCES accounts(id),
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  gate_id uuid REFERENCES gates(id) ON DELETE SET NULL,
  assignment_id uuid REFERENCES gate_assignments(id) ON DELETE SET NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_created_idx ON audit_events (created_at DESC);
CREATE INDEX audit_events_session_idx ON audit_events (session_id, created_at DESC);
