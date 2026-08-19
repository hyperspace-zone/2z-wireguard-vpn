ALTER TABLE gate_status
  ADD COLUMN IF NOT EXISTS agent_revision text,
  ADD COLUMN IF NOT EXISTS agent_built_at timestamptz,
  ADD COLUMN IF NOT EXISTS agent_artifact_sha256 text,
  ADD COLUMN IF NOT EXISTS agent_installed_at timestamptz;

ALTER TABLE gate_status
  DROP CONSTRAINT IF EXISTS gate_status_agent_artifact_sha256_format;

ALTER TABLE gate_status
  ADD CONSTRAINT gate_status_agent_artifact_sha256_format
  CHECK (
    agent_artifact_sha256 IS NULL
    OR agent_artifact_sha256 ~ '^[a-f0-9]{64}$'
  );

CREATE INDEX IF NOT EXISTS gate_status_agent_artifact_sha256_idx
  ON gate_status (agent_artifact_sha256)
  WHERE agent_artifact_sha256 IS NOT NULL;
