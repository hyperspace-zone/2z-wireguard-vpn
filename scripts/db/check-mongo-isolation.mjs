import {execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {createDatabase} from '@hyperspace-zone/db';
if(!process.argv.includes('--outage-drill'))throw new Error('Explicit --outage-drill required; this briefly stops only measurements MongoDB');
if(!process.env.PROBES_DATABASE_URL||!process.env.HS_MONGO_SSH_KEY)throw new Error('Probes URL and SSH key required');
const u=new URL(process.env.PROBES_DATABASE_URL);
if(u.pathname!=='/hyperspace_probes')throw new Error('Refusing operational DB access');
if(process.env.PROBES_COPY_LOCAL_PORT){u.hostname='127.0.0.1';u.port=process.env.PROBES_COPY_LOCAL_PORT;}
const db=createDatabase({connectionString:u.toString(),applicationName:'hyperspace-mongo-isolation-check',maxConnections:1,statementTimeoutMs:2000});
const ssh=command=>execFileSync('ssh',['-i',process.env.HS_MONGO_SSH_KEY,'-o','BatchMode=yes','-o','ConnectTimeout=5','root@88.216.62.149',command],{encoding:'utf8',timeout:15000});
async function probe(path,expected,{stale=false,retry=false}={}){
  for(let attempt=0;attempt<(retry?10:1);attempt++){
    const start=Date.now();const r=await fetch('https://app.hyperspace.zone/api'+path,{signal:AbortSignal.timeout(6000)});
    const body=await r.json();
    console.log(JSON.stringify({path,status:r.status,elapsedMs:Date.now()-start,snapshotStatus:body.snapshotStatus}));
    if(r.status!==expected){if(retry){await sleep(1000);continue;}throw new Error(`Unexpected status for ${path}`);}
    if(stale&&(body.snapshotStatus!=='stale'||r.headers.get('cache-control')!=='no-store'))throw new Error('Unavailable measurements were presented as live/cacheable');
    return body;
  }
  throw new Error(`No recovery for ${path}`);
}
async function counters(){const result=await db.query(`SELECT (SELECT count(*) FROM measurement_delivery_outbox)::int AS backlog,
  (SELECT count(*) FROM trading_probe_job_attempts WHERE completed_at>now()-interval '1 minute')::int AS recent_reports,
  (SELECT MAX(completed_at) FROM probe_measurement_schedule) AS scheduled_at`);return result.rows[0];}
let stopped=false;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{
  try{if(stopped){ssh('systemctl start mongod');stopped=false;}}
  finally{process.exit(130);}
});
try{
  if(ssh('systemctl is-active mongod').trim()!=='active')throw new Error('Mongo was not healthy before drill');
  await probe('/v1/public/benchmarks/gate-matrix',200);
  await probe('/v1/public/trading/latency',200);
  const before=await counters();console.log(JSON.stringify({phase:'before',...before}));
  stopped=true;ssh('systemctl stop mongod');
  await probe('/health',200);await probe('/v1/public/gates',200);
  // Public last-good cache is allowed, but must be visibly stale and expire.
  await sleep(15000);
  await probe('/v1/public/benchmarks/gate-matrix',200,{stale:true});
  const cached=await probe('/v1/public/trading/latency',200,{stale:true});
  await sleep(15000);
  const stillCached=await probe('/v1/public/trading/latency',200,{stale:true});
  if(cached.generatedAt!==stillCached.generatedAt)throw new Error('Cached measurement generation time was rewritten');
  await probe('/health',200);await probe('/v1/public/gates',200);
  const during=await counters();console.log(JSON.stringify({phase:'mongo-stopped',...during}));
  if(during.backlog<=before.backlog||new Date(during.scheduled_at)<=new Date(before.scheduled_at))throw new Error('No new completed probes reached the delivery journal during drill');
  await sleep(15000);await probe('/health',200);
  await sleep(20000);
  await probe('/v1/public/benchmarks/gate-matrix',503);
  await probe('/v1/public/trading/latency',503);
}finally{
  if(stopped)ssh('systemctl start mongod');
  await db.close();
}
console.log('Mongo resumed. Verify backlog drains and core/measurement health recovers before finalizing SQL cleanup.');
await probe('/v1/public/benchmarks/gate-matrix',200,{retry:true});
await probe('/v1/public/trading/latency',200,{retry:true});
