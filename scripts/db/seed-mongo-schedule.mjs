import {createDatabase} from '@hyperspace-zone/db';
if(!process.env.PROBES_DATABASE_URL)throw new Error('Isolated probes URL required');
if(new URL(process.env.PROBES_DATABASE_URL).pathname!=='/hyperspace_probes')throw new Error('Refusing to use core');
const db=createDatabase({connectionString:process.env.PROBES_DATABASE_URL,applicationName:'hyperspace-measurements-schedule-seed',maxConnections:1,statementTimeoutMs:15000});
try{
  await db.query(`INSERT INTO probe_measurement_schedule(kind,source_id,target_id,network_profile,target_revision,completed_at)
    SELECT 'trading',probe_node_id,target_id,network_profile,target_revision,measured_at FROM trading_latency_latest
    ON CONFLICT(kind,source_id,target_id,network_profile) DO UPDATE SET
      completed_at=GREATEST(probe_measurement_schedule.completed_at,EXCLUDED.completed_at),
      target_revision=GREATEST(probe_measurement_schedule.target_revision,EXCLUDED.target_revision)`);
  await db.query(`INSERT INTO probe_measurement_schedule(kind,source_id,target_id,network_profile,completed_at)
    SELECT 'benchmark',source_gate_id,target_gate_id,'all',MAX(measured_at) FROM gate_benchmark_results GROUP BY source_gate_id,target_gate_id
    ON CONFLICT(kind,source_id,target_id,network_profile) DO UPDATE SET
      completed_at=GREATEST(probe_measurement_schedule.completed_at,EXCLUDED.completed_at)`);
  console.log('Seeded small scheduler timestamps; no measurement values copied to PostgreSQL.');
}finally{await db.close();}
