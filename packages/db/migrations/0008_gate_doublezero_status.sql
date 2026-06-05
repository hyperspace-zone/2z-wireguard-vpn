ALTER TABLE gate_status
  ADD COLUMN IF NOT EXISTS doublezero_status jsonb NOT NULL DEFAULT '{}'::jsonb;
