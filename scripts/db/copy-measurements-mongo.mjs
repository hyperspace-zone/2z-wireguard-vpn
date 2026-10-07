import { createDatabase } from '@hyperspace-zone/db';
import { MongoMeasurementStore } from '@hyperspace-zone/control-plane';
import { setTimeout as sleep } from 'node:timers/promises';

if(!process.env.PROBES_DATABASE_URL || !process.env.MEASUREMENTS_MONGO_URL) throw new Error('Probes PostgreSQL and Mongo URLs required; never use core');
const pgUrl = new URL(process.env.PROBES_DATABASE_URL);
if(process.env.PROBES_COPY_LOCAL_PORT){pgUrl.hostname='127.0.0.1';pgUrl.port=process.env.PROBES_COPY_LOCAL_PORT;}
if(pgUrl.pathname!=='/hyperspace_probes') throw new Error('Refusing to copy from an operational database');
let mongoUrl=process.env.MEASUREMENTS_MONGO_URL;
if(process.env.MONGO_COPY_LOCAL_PORT){const u=new URL(mongoUrl);u.hostname='127.0.0.1';u.port=process.env.MONGO_COPY_LOCAL_PORT;mongoUrl=u.toString();}
const pg=createDatabase({connectionString:pgUrl.toString(),applicationName:'hyperspace-measurement-copy',maxConnections:1,statementTimeoutMs:15000});
// Migration batches can require disk checkpoint/fsync time; live readers retain
// their short timeout. A failed batch is replayable using stable collection IDs.
const mongo=new MongoMeasurementStore(mongoUrl,process.env.MEASUREMENTS_MONGO_CA_FILE,{socketTimeoutMs:30000});
const num=value=>value===null||value===undefined?undefined:Number(value);
const copyDays=Number(process.env.MEASUREMENTS_COPY_DAYS??14);
if(!Number.isFinite(copyDays)||copyDays<=0||copyDays>14)throw new Error('Copy window must be within (0,14] days');
const clean=value=>Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined&&v!==null));
const benchmarkMetric=row=>clean({
  transport:row.transport,status:row.status,sourceInterface:row.source_interface,targetEndpoint:row.target_endpoint,
  packetCount:row.packet_count,packetsReceived:row.packets_received,lossPercent:num(row.loss_percent),
  rttMs:row.rtt_p50_ms===null?undefined:clean({min:num(row.rtt_min_ms),p50:num(row.rtt_p50_ms),p95:num(row.rtt_p95_ms),max:num(row.rtt_max_ms)}),
  jitterMs:num(row.jitter_ms),forwardOneWayMs:row.forward_one_way_p50_ms===null?undefined:clean({p50:num(row.forward_one_way_p50_ms),p95:num(row.forward_one_way_p95_ms)}),
  oneWayDiagnostics:row.one_way_clock_error_ms===null?undefined:{clockErrorMs:num(row.one_way_clock_error_ms)},
  measuredAt:new Date(row.measured_at).toISOString(),errorCode:row.error_code,errorMessage:row.error_message?.slice(0,512)
});
const trading=row=>clean({nodeId:row.probe_node_id,targetId:row.target_id,targetRevision:row.target_revision,
  networkProfile:row.network_profile,status:row.status,measuredAt:new Date(row.measured_at??row.bucket_end).toISOString(),
  addressFamily:row.resolved_ip?.includes(':')?'ipv6':row.resolved_ip?'ipv4':'unknown',
  dnsMs:num(row.dns_ms),tcpMs:num(row.tcp_ms),tlsMs:num(row.tls_ms),ttfbMs:num(row.ttfb_ms),
  totalP50Ms:num(row.total_p50_ms),totalP95Ms:num(row.total_p95_ms),totalMinMs:num(row.total_min_ms),totalMaxMs:num(row.total_max_ms),
  jitterMs:num(row.jitter_ms),sampleCount:row.sample_count,failureCount:row.failure_count,errorCode:row.error_code,
  errorMessage:row.error_message?.slice(0,512),resolvedIp:row.resolved_ip
});
try {
  await pg.query('SET default_transaction_read_only=on');
  await mongo.initialize();
  if(!process.argv.includes('--latest-only')) {
    let cursor=process.env.MEASUREMENTS_COPY_CURSOR??null,count=0;
    if(cursor&&!/^[0-9a-f-]{36}$/i.test(cursor))throw new Error('Invalid resume cursor');
    while(true) {
      const result=await pg.query(`SELECT * FROM trading_latency_rollups WHERE bucket_start>now()-make_interval(secs=>$2)
        AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 1000`,[cursor,Math.ceil(copyDays*86400)]);
      if(!result.rows.length) break;
      const writes=result.rows.map(row=>{
        const value=trading(row),bucketStart=new Date(row.bucket_start);
        const document={...value,measuredAt:new Date(value.measuredAt),bucketStart,expiresAt:new Date(bucketStart.getTime()+14*86400_000)};
        const id=`${value.nodeId}:${value.targetId}:${value.networkProfile}:${bucketStart.toISOString()}`;
        return {updateOne:{filter:{_id:id},update:{$setOnInsert:document},upsert:true}};
      });
      await mongo.collection('trading_rollups').bulkWrite(writes,{ordered:false});
      cursor=result.rows.at(-1).id;count+=result.rows.length;
      if(count%50000===0)console.log(JSON.stringify({table:'trading_rollups',copied:count,cursor}));
      await sleep(10);
    }
    console.log(JSON.stringify({table:'trading_rollups',copied:count}));
  }
  const benchmarks=await pg.query(`SELECT * FROM (
    SELECT *,row_number() OVER(PARTITION BY source_gate_id,target_gate_id,transport ORDER BY measured_at DESC,id DESC) AS rank
    FROM gate_benchmark_results) ranked WHERE rank<=2 ${process.argv.includes('--latest-only')?'':"OR measured_at>now()-interval '1 day'"} ORDER BY measured_at`);
  // Bulk-copy raw history; replay only the latest two into bounded projections.
  // Await journalled batches without tens of thousands of serial fsync waits.
  for(let offset=0;offset<benchmarks.rows.length;offset+=1000) {
    const writes=benchmarks.rows.slice(offset,offset+1000).filter(row=>new Date(row.measured_at).getTime()>Date.now()-86400_000).map(row=>{
      const at=new Date(row.measured_at),id=`benchmark-import:${row.id}`;
      const document={_id:id,sourceGateId:row.source_gate_id,targetGateId:row.target_gate_id,transport:row.transport,
        measuredAt:at,metric:benchmarkMetric(row),expiresAt:new Date(at.getTime()+86400_000)};
      return {updateOne:{filter:{_id:id},update:{$setOnInsert:document},upsert:true}};
    });
    if(writes.length)await mongo.collection('benchmark_results').bulkWrite(writes,{ordered:false});
  }
  const recent=benchmarks.rows.filter(row=>Number(row.rank)<=2);
  for(let offset=0;offset<recent.length;offset+=6)await Promise.all(recent.slice(offset,offset+6).map(row=>mongo.deliver(`benchmark-import:${row.id}`,'benchmark',{
    sourceGateId:row.source_gate_id,targetGateId:row.target_gate_id,metric:benchmarkMetric(row)
  })));
  const latest=await pg.query('SELECT * FROM trading_latency_latest');
  for(let offset=0;offset<latest.rows.length;offset+=6)await Promise.all(latest.rows.slice(offset,offset+6).map(row=>mongo.deliver(`trading-import:${row.probe_node_id}:${row.target_id}:${row.network_profile}:${new Date(row.measured_at).toISOString()}`,'trading',trading(row))));
  console.log(JSON.stringify({benchmarks:benchmarks.rows.length,tradingLatest:latest.rows.length}));
} finally {await Promise.all([pg.close(),mongo.close()]);}
