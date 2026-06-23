UPDATE gates
SET spec = jsonb_set(
  spec,
  '{probeHost}',
  to_jsonb(lower(substring(spec->>'probeUrl' from '^https://([^/:?#]+)'))),
  true
)
WHERE NULLIF(spec->>'probeUrl', '') IS NOT NULL
  AND NULLIF(spec->>'probeHost', '') IS NULL
  AND substring(spec->>'probeUrl' from '^https://([^/:?#]+)') IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS gates_probe_host_key
  ON gates (lower(NULLIF(spec->>'probeHost', '')))
  WHERE NULLIF(spec->>'probeHost', '') IS NOT NULL;
