-- Run ONLY after probes cutover and verification. Backup first. These empty
-- legacy measurement tables remain as migration-compatible schema, not storage.
CREATE OR REPLACE FUNCTION reject_core_probe_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='jobs' THEN
    IF NEW.type::text <> 'probe' THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Synthetic writes are forbidden in core; use the probes instance' USING ERRCODE='55000';
END $$;
DROP TRIGGER IF EXISTS core_jobs_no_probes ON jobs;
CREATE TRIGGER core_jobs_no_probes BEFORE INSERT OR UPDATE ON jobs
  FOR EACH ROW WHEN (NEW.type='probe') EXECUTE FUNCTION reject_core_probe_write();
DO $$ DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['gate_benchmark_results','trading_probe_jobs','trading_probe_job_attempts',
    'trading_latency_latest','trading_latency_rollups','trading_probe_leases','trading_probe_node_status'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS core_no_probe_writes ON %I',table_name);
    EXECUTE format('CREATE TRIGGER core_no_probe_writes BEFORE INSERT OR UPDATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_core_probe_write()',table_name);
  END LOOP;
END $$;
