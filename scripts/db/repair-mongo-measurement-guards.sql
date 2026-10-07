-- Repair an already completed Mongo cutover, without deleting any data.
-- ON DELETE SET NULL fires an UPDATE statement even when its table is empty.
-- Row-level guards still reject real legacy writes, but permit that no-op.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $$ BEGIN
  IF current_database()<>'hyperspace_probes' OR current_setting('port')<>'5433' THEN
    RAISE EXCEPTION 'Refusing to modify an operational database';
  END IF;
  IF EXISTS(SELECT 1 FROM gate_benchmark_results)
     OR EXISTS(SELECT 1 FROM trading_latency_latest)
     OR EXISTS(SELECT 1 FROM trading_latency_rollups) THEN
    RAISE EXCEPTION 'Legacy measurements remain; verify Mongo cutover first';
  END IF;
END $$;
DROP TRIGGER mongodb_measurement_storage ON gate_benchmark_results;
DROP TRIGGER mongodb_measurement_storage ON trading_latency_latest;
DROP TRIGGER mongodb_measurement_storage ON trading_latency_rollups;
CREATE TRIGGER mongodb_measurement_storage BEFORE INSERT OR UPDATE ON gate_benchmark_results
  FOR EACH ROW EXECUTE FUNCTION reject_legacy_measurement_write();
CREATE TRIGGER mongodb_measurement_storage BEFORE INSERT OR UPDATE ON trading_latency_latest
  FOR EACH ROW EXECUTE FUNCTION reject_legacy_measurement_write();
CREATE TRIGGER mongodb_measurement_storage BEFORE INSERT OR UPDATE ON trading_latency_rollups
  FOR EACH ROW EXECUTE FUNCTION reject_legacy_measurement_write();
COMMIT;
