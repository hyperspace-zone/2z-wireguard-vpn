-- Keep the visibility map current so exact metrics use the covering index
-- instead of repeatedly scanning historical payloads. Only lower default or
-- looser thresholds; preserve any existing stricter per-table tuning.
DO $$
DECLARE
  setting_name text;
  target_scale numeric;
BEGIN
  FOR setting_name, target_scale IN
    SELECT * FROM (VALUES
      ('autovacuum_vacuum_scale_factor', 0.02),
      ('autovacuum_vacuum_insert_scale_factor', 0.02),
      ('autovacuum_analyze_scale_factor', 0.01)
    ) AS settings(name, scale)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      CROSS JOIN LATERAL pg_options_to_table(reloptions) AS options
      WHERE oid = 'jobs'::regclass
        AND options.option_name = setting_name
        AND options.option_value::numeric <= target_scale
    ) THEN
      EXECUTE format('ALTER TABLE jobs SET (%I = %s)', setting_name, target_scale);
    END IF;
  END LOOP;
END $$;
