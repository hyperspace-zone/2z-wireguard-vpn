-- This database has NO users, wallets, payments, sessions or VPN assignments.
-- Core-owned gate metadata is an eventually consistent local mirror only.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TYPE gate_desired_state AS ENUM ('Enabled','Draining','Disabled','Maintenance');
CREATE TYPE session_mode AS ENUM ('IpToIp','FullTunnel');
CREATE TYPE job_type AS ENUM ('probe');
CREATE TYPE job_phase AS ENUM ('queued','leased','running','succeeded','retryable_failed','dead','acknowledged_dead');

CREATE TABLE gates (
  id uuid PRIMARY KEY, name text NOT NULL UNIQUE, generation bigint NOT NULL,
  desired_state gate_desired_state NOT NULL, identity text NOT NULL UNIQUE,
  city text NOT NULL DEFAULT '', country text NOT NULL DEFAULT '', public_ipv4 text NOT NULL,
  doublezero_interface text NOT NULL DEFAULT 'doublezero0',
  allowed_modes session_mode[] NOT NULL DEFAULT ARRAY['IpToIp','FullTunnel']::session_mode[],
  scheduling_weight integer NOT NULL DEFAULT 100, capacity_limit integer NOT NULL DEFAULT 0,
  required_agent_version text, spec jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gate_status (
  gate_id uuid PRIMARY KEY REFERENCES gates(id) ON DELETE CASCADE,
  observed_generation bigint NOT NULL DEFAULT 0, agent_version text, boot_id text,
  last_seen_at timestamptz, observed_endpoint text, observed_capabilities text[] NOT NULL DEFAULT '{}',
  capacity jsonb NOT NULL DEFAULT '{}', actual_state_hash text, updated_at timestamptz NOT NULL DEFAULT now(),
  doublezero_status jsonb NOT NULL DEFAULT '{}', doublezero_current_device text,
  doublezero_lowest_latency_device text, doublezero_lowest_latency_device_warning boolean,
  clock_error_ms numeric, agent_revision text, agent_built_at timestamptz,
  agent_artifact_sha256 text, agent_installed_at timestamptz
);
CREATE TABLE gate_conditions (
  id uuid PRIMARY KEY, gate_id uuid NOT NULL REFERENCES gates(id) ON DELETE CASCADE,
  type text NOT NULL, status text NOT NULL, reason text NOT NULL, message text,
  observed_generation bigint, last_transition_at timestamptz NOT NULL DEFAULT now(), UNIQUE(gate_id,type)
);
CREATE TABLE gate_leases (
  gate_id uuid PRIMARY KEY REFERENCES gates(id) ON DELETE CASCADE,
  lease_owner text NOT NULL, lease_expires_at timestamptz NOT NULL, heartbeat_at timestamptz NOT NULL
);
CREATE TABLE gate_agent_deployments (
  id uuid PRIMARY KEY, gate_id uuid NOT NULL REFERENCES gates(id), phase text NOT NULL
);
CREATE TABLE probes_catalog_sync (
  id boolean PRIMARY KEY DEFAULT true CHECK(id), last_success_at timestamptz NOT NULL
);
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type job_type NOT NULL CHECK(type='probe'),
  phase job_phase NOT NULL DEFAULT 'queued', gate_id uuid REFERENCES gates(id),
  session_id uuid CHECK(session_id IS NULL), assignment_id uuid CHECK(assignment_id IS NULL),
  payload jsonb NOT NULL DEFAULT '{}', lease_owner text, lease_expires_at timestamptz,
  run_after timestamptz NOT NULL DEFAULT now(), retry_count integer NOT NULL DEFAULT 0,
  max_retries integer NOT NULL DEFAULT 5, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_gate_claim_idx ON jobs(gate_id,phase,run_after);
CREATE INDEX jobs_claim_idx ON jobs(phase,run_after,lease_expires_at);
CREATE INDEX jobs_history_archive_idx ON jobs(updated_at,id) WHERE phase IN ('succeeded','dead');
CREATE TABLE job_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL, lease_owner text NOT NULL, leased_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL, started_at timestamptz, completed_at timestamptz,
  result_summary jsonb, error_code text, actual_state_hash text, UNIQUE(job_id,attempt_number)
);
