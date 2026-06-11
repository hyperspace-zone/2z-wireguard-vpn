DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'gates'
      AND column_name = 'public_ipv4'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS gates_public_ipv4_key ON gates (public_ipv4)';
  ELSIF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'gates'
      AND column_name = 'public_endpoint'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS gates_public_endpoint_key ON gates (public_endpoint)';
  END IF;
END $$;
