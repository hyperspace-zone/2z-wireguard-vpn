-- Manual post-verification step, NOT an automatic schema migration.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='15s';
DO $$ BEGIN
  IF current_database()<>'hyperspace_probes' OR current_setting('port')<>'5433' THEN
    RAISE EXCEPTION 'Refusing to modify an operational database';
  END IF;
  IF EXISTS(SELECT 1 FROM measurement_delivery_outbox WHERE created_at<now()-interval '5 minutes') THEN
    RAISE EXCEPTION 'Measurement delivery is delayed; retry after delivery recovers';
  END IF;
END $$;
TRUNCATE gate_benchmark_results,trading_latency_latest,trading_latency_rollups;
CREATE OR REPLACE FUNCTION reject_legacy_measurement_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Measurement storage has moved to MongoDB; check MEASUREMENTS_MONGO_URL in API and probes-worker' USING ERRCODE='55000';
END $$;
CREATE TRIGGER mongodb_measurement_storage BEFORE INSERT OR UPDATE ON gate_benchmark_results
  FOR EACH ROW EXECUTE FUNCTION reject_legacy_measurement_write();
CREATE TRIGGER mongodb_measurement_storage BEFORE INSERT OR UPDATE ON trading_latency_latest
  FOR EACH ROW EXECUTE FUNCTION reject_legacy_measurement_write();
CREATE TRIGGER mongodb_measurement_storage BEFORE INSERT OR UPDATE ON trading_latency_rollups
  FOR EACH ROW EXECUTE FUNCTION reject_legacy_measurement_write();
COMMIT;
