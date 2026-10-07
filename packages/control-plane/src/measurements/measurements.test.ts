import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { attachMeasurementStore, measurementStore } from "./context.js";
import { deliverMeasurements } from "./delivery.js";
import { MongoMeasurementStore, validDate, type MeasurementStore } from "./mongo.js";
import { insertDueGateBenchmarkProbeJobs, insertGateBenchmarkReport, listLatestGateBenchmarkRoutes } from "../resources/benchmarks/repository.js";
import { scheduleTradingProbeJobs, recordTradingProbeJobReport, readPublicTradingLatency } from "../resources/trading-probes/service.js";
import type { Queryable, TransactionalQueryable } from "../db/queryable.js";

function fakeDatabase(rows: unknown[] = []) {
  const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
  const client = { query: async (sql: string, params: readonly unknown[] = []) => { statements.push({sql,params}); return {rows,rowCount:rows.length}; } };
  const db = { ...client, transaction: async (fn: (value: typeof client) => Promise<unknown>) => fn(client) } as unknown as TransactionalQueryable;
  return { db, client, statements };
}
function fakeStore(): MeasurementStore {
  return { initialize: async()=>{}, deliver: async()=>{}, benchmarks: async()=>[], trading: async()=>[], close: async()=>{} };
}

test("measurement context propagates only through probes transactions and is removed on failure", async () => {
  const {db,client} = fakeDatabase(); const store=fakeStore();
  attachMeasurementStore(db,store);
  await assert.rejects(db.transaction(async tx => { assert.equal(measurementStore(tx),store); throw new Error("rollback"); }));
  assert.equal(measurementStore(client as unknown as Queryable),undefined);
  assert.equal(measurementStore(fakeDatabase().db),undefined);
});
test("benchmark report writes only a replayable probes journal and scheduler state", async () => {
  const {db,statements} = fakeDatabase(); attachMeasurementStore(db,fakeStore());
  await insertGateBenchmarkReport(db,{jobId:"job",sourceGateId:"source",targetGateId:"target",results:[{
    transport:"public",status:"succeeded",measuredAt:new Date().toISOString(),samples:[{secret:"discard"}],rttMs:{p50:12}
  }]});
  assert.match(statements[0]!.sql,/measurement_delivery_outbox/);
  assert.doesNotMatch(statements.map(v=>v.sql).join("\n"),/INSERT INTO gate_benchmark_results/);
  assert.doesNotMatch(String(statements[0]!.params[2]),/samples|discard/);
  assert.match(statements[1]!.sql,/probe_measurement_schedule/);
});
test("both schedulers use queue completion state, not Mongo availability or old SQL measurements", async () => {
  const {db,statements} = fakeDatabase(); attachMeasurementStore(db,{...fakeStore(),trading:async()=>{throw new Error("offline");}});
  await insertDueGateBenchmarkProbeJobs(db,{intervalSeconds:300,probePort:19192,probeCount:10,probeIntervalMs:100,probeTimeoutMs:1000});
  await scheduleTradingProbeJobs(db,true);
  const sql=statements.map(value=>value.sql).join("\n");
  assert.match(sql,/probe_measurement_schedule/); assert.doesNotMatch(sql,/gate_benchmark_results|trading_latency_latest/);
});
test("trading completes its local transaction without contacting offline Mongo or storing SQL measurement values",async()=>{
  const {db,statements}=fakeDatabase([{targetId:"target",targetRevision:1,networkProfile:"direct"}]);
  attachMeasurementStore(db,{...fakeStore(),deliver:async()=>{throw new Error("offline");}});
  const node={id:"node",name:"node",desiredState:"Enabled"} as Parameters<typeof recordTradingProbeJobReport>[1];
  assert.equal(await recordTradingProbeJobReport(db,node,"job",1,{
    status:"succeeded",measuredAt:new Date().toISOString(),sampleCount:3,failureCount:0,totalP50Ms:12
  }),true);
  const sql=statements.map(value=>value.sql).join("\n");
  assert.match(sql,/measurement_delivery_outbox/);assert.match(sql,/probe_measurement_schedule/);
  assert.doesNotMatch(sql,/INSERT INTO trading_latency_/);
  const attempt=statements.find(value=>value.sql.includes('UPDATE trading_probe_job_attempts'))!;
  assert.doesNotMatch(String(attempt.params[4]),/totalP50Ms|measuredAt|sampleCount/);
});
test("failed Mongo delivery retains the journal, backs off, and stops the batch", async () => {
  const {db,statements}=fakeDatabase([{id:"one",kind:"trading",payload:{}},{id:"two",kind:"trading",payload:{}}]);
  let calls=0;
  await assert.rejects(deliverMeasurements(db,{...fakeStore(),deliver:async()=>{calls++;throw new Error("network");}}),/retained/);
  assert.equal(calls,1); assert.match(statements[1]!.sql,/next_attempt_at/);
  assert.doesNotMatch(statements.map(v=>v.sql).join("\n"),/DELETE/);
});
test("successful delivery deletes only the acknowledged event", async () => {
  const {db,statements}=fakeDatabase([{id:"one",kind:"trading",payload:{}}]);
  assert.equal(await deliverMeasurements(db,fakeStore()),1);
  assert.match(statements[1]!.sql,/DELETE.*WHERE id=\$1/); assert.deepEqual(statements[1]!.params,["one"]);
});
test("Mongo-backed matrix preserves same-metro N/A and unknown-metro tests", async () => {
  const {db}=fakeDatabase([{id:"a",name:"A",metro:"lon"},{id:"b",name:"B",metro:"LON"},{id:"c",name:"C",metro:null}]);
  attachMeasurementStore(db,fakeStore()); const routes=await listLatestGateBenchmarkRoutes(db);
  assert.equal(routes.length,6); assert.equal(routes.find(v=>v.sourceGateId==="a"&&v.targetGateId==="b")?.doublezeroApplicability?.status,"not_applicable");
  assert.equal(routes.find(v=>v.sourceGateId==="a"&&v.targetGateId==="c")?.doublezeroApplicability,undefined);
});
test("invalid and future measurement dates cannot poison delivery indefinitely", () => {
  assert.throws(()=>validDate("invalid")); assert.throws(()=>validDate(new Date(Date.now()+600_000).toISOString()));
});

test("Mongo page reads filter to catalog node/target IDs before fetching measurement documents", async () => {
  const db = { query: async (sql: string) => ({ rows: sql.includes("FROM trading_probe_nodes")
    ? [{ id: "live-node" }] : [{ id: "first", key: "first", sortOrder: 1 }, { id: "chosen", key: "chosen", sortOrder: 2 }] }),
    transaction: async () => { throw new Error("Unexpected write transaction"); }
  } as unknown as TransactionalQueryable;
  const seen: unknown[] = [];
  attachMeasurementStore(db, { ...fakeStore(), trading: async selection => { seen.push(selection); return []; } });
  await readPublicTradingLatency(db, "cex", "chosen");
  await readPublicTradingLatency(db, "cex", "unknown");
  await readPublicTradingLatency(db);
  assert.deepEqual(seen, [
    { nodeIds: ["live-node"], targetIds: ["chosen"] },
    { nodeIds: ["live-node"], targetIds: ["first"] },
    { nodeIds: ["live-node"], targetIds: ["first", "chosen"] }
  ]);
});

test("live Mongo: replay, out-of-order delivery, latest-two cycles, literal error strings, and TTL indexes", {
  skip: !process.env.MONGO_TEST_URL
}, async () => {
  const store = new MongoMeasurementStore(process.env.MONGO_TEST_URL!,process.env.MEASUREMENTS_MONGO_CA_FILE);
  const suffix="__test_"+randomUUID().replaceAll("-","");
  const collection=store.collection.bind(store);
  const names=new Set<string>();
  store.collection = name => { names.add(name+suffix);return collection(name+suffix); };
  const now=new Date(); const older=new Date(now.getTime()-60_000);
  const value={nodeId:"node",targetId:"target",networkProfile:"direct",status:"succeeded" as const,targetRevision:1,
    measuredAt:now.toISOString(),sampleCount:1,failureCount:0,totalP50Ms:4,errorMessage:"$notAnExpression"};
  try {
    await store.initialize();
    await store.deliver("event-new","trading",value);
    await store.deliver("event-new","trading",value);
    await store.deliver("event-old","trading",{...value,measuredAt:older.toISOString(),totalP50Ms:200});
    assert.equal(await store.collection("trading_results").countDocuments(),2);
    const latest=await store.trading();assert.equal(latest.length,1);assert.equal(latest[0]!.totalP50Ms,4);
    assert.equal(latest[0]!.errorMessage,"$notAnExpression");
    assert.equal((await store.trading({ nodeIds: ["node"], targetIds: ["target"] })).length, 1);
    assert.equal((await store.trading({ nodeIds: ["retired"], targetIds: ["target"] })).length, 0);
    assert.equal((await store.trading({ nodeIds: ["node"], targetIds: [] })).length, 0);
    assert.ok((await store.collection("trading_latest").indexes()).some(index => index.key.targetId === 1 && index.key.nodeId === 1));
    const at=new Date(Math.floor(now.getTime()/300_000)*300_000+1_000).toISOString();
    await store.deliver("bucket-new","trading",{...value,measuredAt:at});
    await store.deliver("bucket-new","trading",{...value,measuredAt:at});
    for (const [id,date] of [["b-new",now],["b-old",older],["b-old",older]] as const) {
      await store.deliver(id,"benchmark",{sourceGateId:"a",targetGateId:"b",metric:{transport:"public",status:"failed",measuredAt:date.toISOString()}});
    }
    const benchmark=(await store.benchmarks())[0]!;assert.equal(benchmark.recent.length,2);
    assert.equal(benchmark.recent[0]!.eventId,"b-new");
    assert.equal(await store.collection("benchmark_results").countDocuments(),2);
    assert.equal((await store.benchmarks(["a", "b"])).length, 1);
    assert.equal((await store.benchmarks(["a"])).length, 0);
    assert.equal((await store.benchmarks([])).length, 0);
    const indexes=await store.collection("trading_rollups").indexes();
    assert.ok(indexes.some(index=>index.expireAfterSeconds===0));
    // Replaying a historical event must not recreate already expired raw data.
    await store.deliver("expired","trading",{...value,measuredAt:new Date(Date.now()-2*86400_000).toISOString()});
    assert.equal(await store.collection("trading_results").countDocuments({_id:"expired"}),0);
    assert.equal((await store.trading())[0]!.totalP50Ms,4);
  } finally {
    for (const name of names) await collection(name).drop().catch(()=>undefined);
    await store.close();
  }
});
