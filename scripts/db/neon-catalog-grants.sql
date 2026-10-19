-- Apply as the application/managed owner after a no-ACL restore. Do not grant
-- SELECT on all tables: the optional worker must not read billing or wallets.
\set ON_ERROR_STOP on
BEGIN;
GRANT USAGE ON SCHEMA public TO hyperspace_catalog_reader;
GRANT SELECT ON gates,gate_status,gate_conditions,gate_leases,
  trading_probe_nodes,trading_probe_auth_tokens,trading_probe_targets
  TO hyperspace_catalog_reader;
-- This is deliberately a column grant, not visible in table_privileges alone.
GRANT SELECT (id, gate_id, phase) ON gate_agent_deployments TO hyperspace_catalog_reader;
ALTER ROLE hyperspace_catalog_reader SET default_transaction_read_only = on;
COMMIT;
