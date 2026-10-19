\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ DECLARE relation_name text; has_rows boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM jobs WHERE type = 'probe') THEN
    RAISE EXCEPTION 'Core still contains probe jobs; finish Mongo cutover first';
  END IF;
  FOREACH relation_name IN ARRAY ARRAY['gate_benchmark_results','trading_probe_jobs','trading_probe_job_attempts',
    'trading_latency_latest','trading_latency_rollups','trading_probe_leases','trading_probe_node_status'] LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)', relation_name) INTO has_rows;
    IF has_rows THEN RAISE EXCEPTION 'Core still contains probe rows in %', relation_name; END IF;
  END LOOP;
END $$;
\ir activate-core-isolation.sql
COMMIT;
