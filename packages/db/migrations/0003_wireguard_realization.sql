ALTER TYPE gate_assignment_phase ADD VALUE IF NOT EXISTS 'prepared';

ALTER TABLE gate_assignment_status
  ADD COLUMN IF NOT EXISTS local_material jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS reported_state jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE rendered_plan_secrets (
  plan_id uuid PRIMARY KEY REFERENCES rendered_plans(id) ON DELETE CASCADE,
  encryption_method text NOT NULL,
  nonce text NOT NULL,
  ciphertext text NOT NULL,
  auth_tag text NOT NULL,
  aad text NOT NULL,
  key_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE artifact_payloads (
  artifact_id uuid PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  payload_type text NOT NULL,
  encryption_method text NOT NULL,
  nonce text NOT NULL,
  ciphertext text NOT NULL,
  auth_tag text NOT NULL,
  aad text NOT NULL,
  key_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
