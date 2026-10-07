import {createDatabase} from '@hyperspace-zone/db';
import {setTimeout as sleep} from 'node:timers/promises';
if(!process.env.DATABASE_URL || !process.env.PROBES_DATABASE_URL || process.env.DATABASE_URL===process.env.PROBES_DATABASE_URL) throw new Error('Distinct core and probes URLs required');
const core=createDatabase({connectionString:process.env.DATABASE_URL,applicationName:'hyperspace-probes-copy-readonly',maxConnections:1,statementTimeoutMs:15000});
const probes=createDatabase({connectionString:process.env.PROBES_DATABASE_URL,applicationName:'hyperspace-probes-copy',maxConnections:1,statementTimeoutMs:15000});
const active="phase IN ('queued','leased')";
const manifests=[
  ['jobs',"type='probe'",'id'],
  ['job_attempts',"job_id IN (SELECT id FROM jobs WHERE type='probe')",'id'],
  ['gate_benchmark_results','true','id'],
  ['trading_probe_node_status','true','probe_node_id'],
  ['trading_probe_leases','true','probe_node_id'],
  ['trading_latency_latest','true','probe_node_id','target_id','network_profile'],
  ['trading_probe_jobs',active,'id'],
  ['trading_probe_job_attempts',`job_id IN (SELECT id FROM trading_probe_jobs WHERE ${active})`,'id'],
  ...(process.argv.includes('--latest-only')?[]:[['trading_latency_rollups',"bucket_start >= now()-interval '14 days'",'bucket_start','id']])
];
try {
  await core.query('SET default_transaction_read_only=on');
  if(process.argv.includes('--latest-only')) {
    const destination=(await probes.query('SELECT current_database() AS name')).rows[0]?.name;
    if(destination!=='hyperspace_probes')throw new Error('Final copy may only refresh the hyperspace_probes synthetic queue');
    // Pre-copy active jobs can finish while core keeps scheduling successors.
    // They conflict with the one-active-target index during the frozen copy.
    // Only the disposable destination queue is reset; core remains untouched.
    await probes.query('TRUNCATE trading_probe_job_attempts,trading_probe_jobs');
  }
  for(const [table,condition,...order] of manifests){
    const columns=(await probes.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",[table])).rows.map(row=>row.column_name);
    const keys=table==='trading_latency_latest'?['probe_node_id','target_id','network_profile']:[table==='trading_probe_node_status'||table==='trading_probe_leases'?'probe_node_id':'id'];
    const assignments=columns.filter(column=>!keys.includes(column)).map(column=>`"${column}"=EXCLUDED."${column}"`).join(',');
    let cursor=null,count=0;
    while(true){
      const params=cursor??[];
      const predicate=cursor?`AND (${order.join(',')}) > (${order.map((_,i)=>'$'+(i+1)).join(',')})`:'';
      const rows=(await core.query(`SELECT row_to_json(rows) AS value FROM (SELECT * FROM ${table} WHERE ${condition} ${predicate} ORDER BY ${order.join(',')} LIMIT 5000) rows`,params)).rows.map(row=>row.value);
      if(!rows.length)break;
      let insertRows=rows;
      if(['job_attempts','gate_benchmark_results','trading_probe_job_attempts'].includes(table)){
        const parent=table==='trading_probe_job_attempts'?'trading_probe_jobs':'jobs';
        const ids=rows.map(row=>row.job_id).filter(Boolean);
        const present=new Set((await probes.query(`SELECT id FROM ${parent} WHERE id=ANY($1::uuid[])`,[ids])).rows.map(row=>row.id));
        // Online pre-copy can race new parent creation. Skip its attempts now;
        // the final frozen copy imports them. A benchmark keeps its measurement
        // with a null optional job link rather than dropping useful evidence.
        insertRows=table==='gate_benchmark_results'?rows.map(row=>row.job_id&&!present.has(row.job_id)?{...row,job_id:null}:row):rows.filter(row=>present.has(row.job_id));
      }
      if(insertRows.length)await probes.query(`INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table},$1::json) ON CONFLICT(${keys.join(',')}) DO UPDATE SET ${assignments}`,[JSON.stringify(insertRows)]);
      count+=rows.length;cursor=order.map(column=>rows.at(-1)[column]);
      await sleep(10);
    }
    console.log(JSON.stringify({table,copied:count}));
  }
}finally{await core.close();await probes.close();}
