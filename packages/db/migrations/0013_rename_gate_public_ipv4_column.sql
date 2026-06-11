DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'gates'
      AND column_name = 'public_endpoint'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'gates'
      AND column_name = 'public_ipv4'
  ) THEN
    ALTER TABLE gates RENAME COLUMN public_endpoint TO public_ipv4;
  END IF;
END $$;

DROP INDEX IF EXISTS gates_public_endpoint_key;

CREATE UNIQUE INDEX IF NOT EXISTS gates_public_ipv4_key
  ON gates (public_ipv4);
