ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'deploy_agent';
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'rollback_agent';

CREATE TABLE gate_agent_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL,
  revision text NOT NULL,
  built_at timestamptz NOT NULL,
  artifact_sha256 text NOT NULL UNIQUE,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gate_agent_releases_sha256_format
    CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$')
);

CREATE TABLE gate_agent_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_id uuid NOT NULL REFERENCES gates(id),
  release_id uuid NOT NULL REFERENCES gate_agent_releases(id),
  phase text NOT NULL DEFAULT 'queued',
  previous_agent_version text,
  previous_agent_revision text,
  previous_artifact_sha256 text,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  staged_at timestamptz,
  installed_at timestamptz,
  verified_at timestamptz,
  rollback_requested_at timestamptz,
  rollback_attempt_count integer NOT NULL DEFAULT 0,
  rolled_back_at timestamptz,
  failed_at timestamptz,
  verification_deadline_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes',
  failure_code text,
  failure_message text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gate_agent_deployments_phase_check CHECK (
    phase IN (
      'queued',
      'staging',
      'verifying',
      'succeeded',
      'rollback_requested',
      'rolling_back',
      'rolled_back',
      'failed'
    )
  ),
  CONSTRAINT gate_agent_deployments_previous_sha256_format CHECK (
    previous_artifact_sha256 IS NULL
    OR previous_artifact_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT gate_agent_deployments_rollback_attempt_count_check CHECK (
    rollback_attempt_count >= 0 AND rollback_attempt_count <= 3
  )
);

CREATE UNIQUE INDEX gate_agent_deployments_one_active_per_gate_idx
  ON gate_agent_deployments (gate_id)
  WHERE phase IN ('queued', 'staging', 'verifying', 'rollback_requested', 'rolling_back');

CREATE INDEX gate_agent_deployments_reconcile_idx
  ON gate_agent_deployments (phase, verification_deadline_at, updated_at);

CREATE TABLE gate_agent_deployment_events (
  id bigserial PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES gate_agent_deployments(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX gate_agent_deployment_events_history_idx
  ON gate_agent_deployment_events (deployment_id, created_at, id);
