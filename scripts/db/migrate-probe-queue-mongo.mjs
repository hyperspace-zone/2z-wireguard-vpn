// Read-only PostgreSQL -> Mongo cutover checkpoint. Never prints rows, URLs or
// token hashes, never deletes SQL history. Run only while API/probes writers stop.
import { spawnSync } from 'node:child_process';
import { createDatabase } from '../../packages/db/dist/index.js';
import { MongoMeasurementStore, MongoProbeStore } from '../../packages/control-plane/dist/index.js';
import { jobTarget } from '../../packages/control-plane/dist/probes/catalog.js';
import { syncProbesCatalog } from '../../apps/control-plane-worker/dist/probes/catalog-sync.js';

const execute = process.argv.includes('--execute');
for (const key of ['PROBES_DATABASE_URL','PROBES_CATALOG_DATABASE_URL','MEASUREMENTS_MONGO_URL']) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}
if (process.env.PROBES_BACKEND === 'mongodb') throw new Error('Use the pre-cutover environment, not an already switched runtime');
if (execute) {
  for (const service of ['hyperspace-control-plane-api','hyperspace-probes-worker']) {
    if (spawnSync('systemctl',['is-active','--quiet',service]).status !== 3) throw new Error(`Stop ${service} before freezing the source`);
  }
}
const source = createDatabase({connectionString:process.env.PROBES_DATABASE_URL,applicationName:'probe-queue-migration-readonly',maxConnections:1,statementTimeoutMs:10000});
const core = createDatabase({connectionString:process.env.PROBES_CATALOG_DATABASE_URL,applicationName:'probe-catalog-migration-readonly',maxConnections:1,statementTimeoutMs:10000});
const measurements = new MongoMeasurementStore(process.env.MEASUREMENTS_MONGO_URL,process.env.MEASUREMENTS_MONGO_CA_FILE);
const queue = new MongoProbeStore(measurements);
try {
  const snapshot = await source.transaction(async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const identity=await client.query('SELECT current_database() AS name');
    if(identity.rows[0]?.name !== 'hyperspace_probes') throw new Error('Source must be the disposable hyperspace_probes database');
    const read=async sql=>(await client.query(sql)).rows;
    return {
      benchmark:await read(`SELECT jobs.*, COALESCE((SELECT max(attempt_number) FROM job_attempts WHERE job_id=jobs.id),0)::int AS attempts
        FROM jobs WHERE type='probe' AND phase IN ('queued','leased','running','retryable_failed') ORDER BY created_at`),
      trading:await read(`SELECT * FROM trading_probe_jobs WHERE phase IN ('queued','leased') ORDER BY created_at`),
      targets:await read('SELECT * FROM trading_probe_targets'),
      statuses:await read(`SELECT status.*, leases.lease_expires_at FROM trading_probe_node_status status
        LEFT JOIN trading_probe_leases leases USING(probe_node_id)`),
      schedule:await read('SELECT * FROM probe_measurement_schedule'),
      outbox:await read('SELECT * FROM measurement_delivery_outbox ORDER BY created_at LIMIT 10001')
    };
  });
  if(snapshot.outbox.length>10000) throw new Error('Drain the old delivery backlog below 10000 before cutover');
  const counts=Object.fromEntries(Object.entries(snapshot).map(([name,rows])=>[name,rows.length]));
  if(!execute){console.log(JSON.stringify({dryRun:true,counts}));process.exitCode=0;}
  else {
    const marker=queue.collection('migration');
    const existing=await marker.findOne({_id:'postgres-cutover-v1'});
    if(existing?.complete) throw new Error('Cutover already imported; do not replay an old SQL snapshot over Mongo jobs');
    if(!existing && await queue.tasks.countDocuments({}, {limit:1})) throw new Error('Mongo queue is not empty; investigate before importing');
    await queue.initialize(); await measurements.initialize();
    await marker.updateOne({_id:'postgres-cutover-v1'},{$setOnInsert:{startedAt:new Date()}},{upsert:true});
    // Reuse the existing read-only core snapshot boundary, not its SQL mirror.
    const {createMongoProbesContext}=await import('../../packages/control-plane/dist/index.js');
    await syncProbesCatalog(core,createMongoProbesContext(queue));
    const storeTask=async task=>queue.tasks.updateOne({_id:task._id},{$setOnInsert:task},{upsert:true});
    for(const row of snapshot.benchmark){
      const ntp=row.payload.kind==='gate_ntp_discovery_v1';
      if(!ntp && row.payload.kind!=='gate_benchmark_v1') throw new Error('Unknown synthetic job kind; migration refused');
      const leased=['leased','running'].includes(row.phase);
      await storeTask({_id:row.id,key:ntp?`ntp:${row.gate_id}`:`benchmark:${row.gate_id}:${row.payload.targetGateId}`,
        kind:ntp?'ntp':'benchmark',sourceId:row.gate_id,targetId:ntp?row.gate_id:row.payload.targetGateId,revision:0,
        intervalMs:Number(ntp?(process.env.NTP_DISCOVERY_INTERVAL_SECONDS??86400):(process.env.BENCHMARK_INTERVAL_SECONDS??300))*1000,
        payload:row.payload,phase:leased?'leased':'queued',active:true,attempts:row.attempts,maxAttempts:Math.max(row.attempts+1,row.max_retries),
        createdAt:row.created_at,updatedAt:row.updated_at,runAfter:row.run_after,
        ...(leased?{claimId:row.id,leaseOwner:row.lease_owner??'',leaseExpiresAt:row.lease_expires_at??new Date(0)}:{})});
    }
    for(const row of snapshot.trading){
      const target=snapshot.targets.find(item=>item.id===row.target_id);
      if(!target) throw new Error('Missing target for active trading job');
      if(row.network_profile!=='direct') throw new Error('Unsupported active network profile');
      const leased=row.phase==='leased';
      await storeTask({_id:row.id,key:`trading:${row.probe_node_id}:${row.target_id}:direct`,kind:'trading',sourceId:row.probe_node_id,targetId:row.target_id,
        revision:row.target_revision,intervalMs:Number(target.interval_seconds)*1000,payload:{networkProfile:'direct',target:jobTarget({...target,revision:row.target_revision})},
        phase:leased?'leased':'queued',active:true,attempts:row.retry_count,maxAttempts:Math.max(row.retry_count+1,row.max_retries),
        createdAt:row.created_at,updatedAt:row.updated_at,runAfter:row.run_after,
        ...(leased?{claimId:row.id,leaseOwner:row.lease_owner??'',leaseExpiresAt:row.lease_expires_at??new Date(0)}:{})});
    }
    for(const row of snapshot.statuses){
      if(!row.last_seen_at) continue;
      await queue.collection('node_status').updateOne({_id:row.probe_node_id},{$setOnInsert:{lastSeenAt:row.last_seen_at,
        leaseExpiresAt:row.lease_expires_at??new Date(0),report:{bootId:row.boot_id??'',agentVersion:row.agent_version??'',
          capabilities:row.observed_capabilities,networkProfiles:row.active_network_profiles,spoolDepth:row.spool_depth,selfTest:row.last_self_test}}},{upsert:true});
    }
    for(const row of snapshot.schedule){
      const key=row.kind==='benchmark'?`benchmark:${row.source_id}:${row.target_id}`:`trading:${row.source_id}:${row.target_id}:${row.network_profile}`;
      await queue.collection('schedule').updateOne({_id:key},{$setOnInsert:{completedAt:row.completed_at,revision:row.target_revision}},{upsert:true});
    }
    // Pending SQL outbox entries are imported with the original event IDs.
    // Replaying them after rollback is idempotent in the measurement store.
    for(const row of snapshot.outbox){
      const id=`import:${row.id}`;
      await storeTask({_id:id,key:id,kind:row.kind,sourceId:row.payload.nodeId??row.payload.sourceGateId,targetId:row.payload.targetId??row.payload.targetGateId,
        revision:row.payload.targetRevision??0,intervalMs:0,payload:{},phase:'completed',active:true,attempts:0,maxAttempts:1,
        createdAt:row.created_at,updatedAt:new Date(),runAfter:new Date(),completedAt:row.created_at,
        deliveryPending:true,deliveryAfter:new Date(),events:[{id:row.id,kind:row.kind,payload:row.payload}]});
    }
    await marker.updateOne({_id:'postgres-cutover-v1'},{$set:{complete:true,completedAt:new Date(),counts}});
    console.log(JSON.stringify({imported:true,counts,sourceUnmodified:true}));
  }
} finally {await Promise.all([source.close(),core.close(),measurements.close()]);}
