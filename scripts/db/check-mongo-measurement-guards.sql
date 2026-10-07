-- Native PostgreSQL integration check; every action is rolled back.
BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='3s';
DO $$ BEGIN
  IF current_database()<>'hyperspace_probes' OR current_setting('port')<>'5433' THEN
    RAISE EXCEPTION 'Refusing to check an operational database';
  END IF;
END $$;
UPDATE gate_benchmark_results SET job_id=NULL WHERE false;
UPDATE trading_latency_latest SET target_revision=target_revision WHERE false;
UPDATE trading_latency_rollups SET target_revision=target_revision WHERE false;
DO $$ BEGIN
  BEGIN
    INSERT INTO gate_benchmark_results(source_gate_id,target_gate_id,transport,status)
      VALUES('00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000','public','succeeded');
    RAISE EXCEPTION 'Legacy measurement guard did not reject a real INSERT';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END $$;
ROLLBACK;
