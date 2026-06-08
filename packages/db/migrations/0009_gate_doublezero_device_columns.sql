ALTER TABLE gate_status
  ADD COLUMN IF NOT EXISTS doublezero_current_device text,
  ADD COLUMN IF NOT EXISTS doublezero_lowest_latency_device text,
  ADD COLUMN IF NOT EXISTS doublezero_lowest_latency_device_warning boolean;

UPDATE gate_status
SET
  doublezero_current_device = NULLIF(BTRIM(doublezero_status->>'currentDevice'), ''),
  doublezero_lowest_latency_device = NULLIF(BTRIM(doublezero_status->>'lowestLatencyDevice'), ''),
  doublezero_lowest_latency_device_warning = CASE
    WHEN doublezero_status->>'lowestLatencyDeviceWarning' IN ('true', 'false')
      THEN (doublezero_status->>'lowestLatencyDeviceWarning')::boolean
    ELSE NULL
  END
WHERE doublezero_status <> '{}'::jsonb;
