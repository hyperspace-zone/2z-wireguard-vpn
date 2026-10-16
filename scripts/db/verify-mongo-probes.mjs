// Read-only deployment acceptance. No credentials, token hashes or job payloads
// are printed. Run on the control-plane with its protected probes-worker env.
import assert from 'node:assert/strict';
import {MongoMeasurementStore,MongoProbeStore,catalogGates,catalogNodes} from '../../packages/control-plane/dist/index.js';
assert.equal(process.env.PROBES_BACKEND,'mongodb','Mongo-only probes backend is required');
assert.ok(!process.env.PROBES_DATABASE_URL,'Retired SQL URL must not remain in runtime');
const measurements=new MongoMeasurementStore(process.env.MEASUREMENTS_MONGO_URL,process.env.MEASUREMENTS_MONGO_CA_FILE);
const queue=new MongoProbeStore(measurements);
try {
  const catalog=await queue.catalog();
  const marker=await queue.collection('migration').findOne({_id:'postgres-cutover-v1'});
  const since=marker?.completedAt??new Date(Date.now()-600000);
  const completed=await queue.tasks.aggregate([
    {$match:{createdAt:{$gte:since},phase:'completed',outcome:{$nin:['cancelled','superseded']}}},
    {$group:{_id:{kind:'$kind',sourceId:'$sourceId'},count:{$sum:1},latest:{$max:'$completedAt'}}}
  ],{maxTimeMS:1500}).toArray();
  const gates=catalogGates(catalog).filter(row=>row.gate.desired_state==='Enabled').map(row=>({
    name:row.gate.name,ready:row.ready,schedulable:row.schedulable,benchmarkEligible:row.benchmarkReady,
    completed:completed.find(item=>item._id.kind==='benchmark'&&item._id.sourceId===row.gate.id)?.count??0
  }));
  const nodes=(await queue.tradingNodeMetrics()).filter(row=>row.enabled).map(row=>{
    const node=catalogNodes(catalog).find(item=>item.name===row.node);
    return {...row,completed:completed.find(item=>item._id.kind==='trading'&&item._id.sourceId===node?.id)?.count??0};
  });
  const stats=await queue.stats();
  const result={checkedAt:new Date().toISOString(),since,stats,gates,nodes};
  console.log(JSON.stringify(result,null,2));
  if(process.argv.includes('--require-new-results')){
    assert.ok(stats.catalogAge<15,'Catalog is not refreshing');
    assert.ok(gates.some(row=>row.benchmarkEligible),'No eligible gates; acceptance needs explicit investigation');
    for(const row of gates.filter(row=>row.benchmarkEligible))assert.ok(row.completed>0,`No new benchmark completion: ${row.name}`);
    for(const row of nodes){
      assert.ok(row.fresh,`Trading heartbeat is not fresh: ${row.node}`);
      assert.ok(row.completed>0,`No new trading completion: ${row.node}`);
    }
    assert.ok(stats.oldestAge<60,'Pending result delivery is not progressing');
  }
} finally {await measurements.close();}
