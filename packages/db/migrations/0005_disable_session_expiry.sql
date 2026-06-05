UPDATE sessions
SET spec = spec - 'ttlSeconds',
    updated_at = now()
WHERE spec ? 'ttlSeconds';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sessions'
      AND column_name = 'ttl_seconds'
  ) THEN
    EXECUTE 'UPDATE sessions SET ttl_seconds = NULL, updated_at = now() WHERE ttl_seconds IS NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'session_status'
      AND column_name = 'effective_expiry_at'
  ) THEN
    EXECUTE 'UPDATE session_status SET effective_expiry_at = NULL, updated_at = now() WHERE effective_expiry_at IS NOT NULL';
  END IF;
END $$;
