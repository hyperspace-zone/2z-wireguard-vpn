import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { MongoMeasurementStore } from "../measurements/mongo.js";
import { MongoProbeStore } from "./mongo.js";
import { createMongoProbesContext } from "./context.js";
import { catalogGates, catalogNodes, publicCatalogGates, type ProbeCatalog } from "./catalog.js";
import { sha256Hex } from "../security/tokens.js";
import { listLatestGateBenchmarkRoutes } from "../resources/benchmarks/repository.js";
import { readPublicGateBenchmarkMatrix } from "../read-models/public-benchmarks.query.js";
import { recordTradingProbeHeartbeat, claimTradingProbeJob, recordTradingProbeJobReport, readPublicTradingLatency } from "../resources/trading-probes/service.js";
import { claimGateJob } from "../resources/jobs/leasing.js";
import { recordGateJobReport } from "../resources/jobs/attempts.js";
import { authenticateTradingProbeToken } from "../security/trading-probe-auth.js";

const benchmarkConfig = { intervalSeconds: 300, probePort: 19192, probeCount: 3, probeIntervalMs: 100, probeTimeoutMs: 1000 };
const node = { id: "node-a", name: "node-a", generation: 1, desiredState: "Enabled" as const };
const result = () => ({ status: "succeeded" as const, measuredAt: new Date().toISOString(), sampleCount: 3, failureCount: 0, totalP50Ms: 12 });
const heartbeat = { bootId: "boot", agentVersion: "test", capabilities: [], networkProfiles: ["direct"], spoolDepth: 0, selfTest: {} };

function fixture(): ProbeCatalog {
  return {
    gates: ["a", "b", "c"].map((id,i) => ({ id, name: id, desired_state: i === 2 ? "Maintenance" : "Enabled", country: "GB", city: "London",
      public_ipv4: `192.0.2.${i+1}`, spec: { doubleZeroEnv: "mainnet-beta", probeUrl: `https://${id}.invalid` }, doublezero_interface: "doublezero0" })),
    gate_status: ["a", "b", "c"].map((id,i) => ({ gate_id: id, observed_capabilities: ["doublezero0:up", "chrony:sync", "ntp-discovery:enabled"],
      doublezero_status: { metro: i ? "LON" : "lon", tunnelStatus: "BGP Session Up", network: "mainnet-beta", tunnelSrc: `192.0.2.${i+1}` } })),
    gate_conditions: ["a", "b", "c"].flatMap(id => ["Ready", "Schedulable", "AgentConnected"].map(type => ({ gate_id: id, type, status: "True" }))),
    gate_leases: ["a", "b", "c"].map(id => ({ gate_id: id, lease_expires_at: new Date(Date.now()+60_000).toISOString() })),
    gate_agent_deployments: [],
    trading_probe_nodes: [{ id: node.id, name: node.name, generation: 1, desired_state: "Enabled", placement_kind: "gate_host", gate_id: "a", city: "London", country: "GB", latitude: 51.5, longitude: 0, provider: "test", region_code: "eu" }],
    trading_probe_auth_tokens: [{ probe_node_id: node.id, token_hash: sha256Hex("token"), expires_at: null, revoked_at: null }],
    trading_probe_targets: [{ id: "target", target_key: "cex-test", revision: 1, category: "cex", display_name: "Test", product: "public", protocol: "http_json", scheme: "https",
      hostname: "example.invalid", port: 443, path: "/", request_method: "GET", expected_status: 200, response_kind: "json_object", timeout_ms: 1000,
      sample_count: 3, interval_seconds: 30, enabled: true, sort_order: 1 }]
  };
}

test("catalog projections preserve maintenance, lease expiry, deployment exclusion and disabled gate-host nodes", () => {
  const catalog = fixture();
  assert.equal(publicCatalogGates(catalog).length, 3);
  assert.equal(publicCatalogGates(catalog).find(row=>row.id==="c")!.schedulable, false);
  catalog.gate_agent_deployments!.push({ gate_id: "a", phase: "verifying" });
  assert.equal(catalogGates(catalog).find(row=>row.gate.id==="a")!.benchmarkReady, false);
  catalog.gate_leases![1]!.lease_expires_at = new Date(Date.now()-1).toISOString();
  assert.equal(catalogGates(catalog).find(row=>row.gate.id==="b")!.connected, false);
  catalog.gates![0]!.desired_state = "Disabled";
  assert.equal(catalogNodes(catalog)[0]!.desired_state, "Disabled");
  catalog.trading_probe_nodes![0]!.placement_kind = "testnode";
  assert.equal(catalogNodes(catalog)[0]!.desired_state, "Enabled");
});

test("Mongo context has no SQL connection or transaction fallback", async () => {
  const store = new MongoMeasurementStore("mongodb://127.0.0.1:1/test");
  const context = createMongoProbesContext(new MongoProbeStore(store));
  await assert.rejects(context.query("SELECT 1"), /SQL is forbidden/);
  await assert.rejects(context.transaction(async()=>{}), /SQL is forbidden/);
  assert.throws(()=>context.pool, /SQL is forbidden/);
  await context.close(); await store.close();
});

test("Mongo initial connection failure is retried explicitly without restarting or reopening a closed store", async () => {
  const measurements=new MongoMeasurementStore("mongodb://127.0.0.1:1/test");
  const queue=new MongoProbeStore(measurements);
  let attempts=0;
  measurements.client.connect=async()=>{attempts++;throw new Error("initial connection unavailable");};
  try {
    // No collection operation may bypass an explicit reconnect after the driver
    // retained a closed topology. Each next caller must be able to retry.
    for(const operation of [()=>measurements.initialize(),()=>measurements.benchmarks(),()=>measurements.trading(),
      ()=>measurements.stats(),()=>queue.initialize(),()=>queue.catalog(),()=>queue.stats(),()=>queue.deliver(),
      ()=>queue.heartbeat(node,heartbeat),()=>queue.reportTrading(node,"claim",1,result())]) {
      await assert.rejects(operation(),/initial connection unavailable/);
    }
    assert.equal(attempts,10);
    measurements.client.connect=async()=>{attempts++;return measurements.client;};
    await measurements.connect();
    assert.equal(attempts,11);
    await measurements.close();
    await assert.rejects(measurements.connect(),/store is closed/);
    assert.equal(attempts,11);
  } finally {await measurements.close();}
});

test("live Mongo probes queue: atomic claims, fencing, replay, recovery, retention and read models without SQL", {
  skip: !process.env.MONGO_TEST_URL
}, async t => {
  const measurements = new MongoMeasurementStore(process.env.MONGO_TEST_URL!, process.env.MEASUREMENTS_MONGO_CA_FILE);
  const prefix = `__test_${randomUUID().replaceAll("-", "")}_`;
  const originalCollection = measurements.collection.bind(measurements);
  const measurementNames = new Set<string>();
  measurements.collection = name => { measurementNames.add(prefix+name); return originalCollection(prefix+name); };
  const queue = new MongoProbeStore(measurements, prefix);
  const context = createMongoProbesContext(queue);
  const setCatalog = async (catalog = fixture()) => queue.replaceCatalog(catalog, new Date());
  const reset = async () => {
    for (const name of ["jobs", "schedule", "node_status", "catalog"]) await queue.collection(name).deleteMany({});
    await setCatalog();
  };
  try {
    await measurements.initialize(); await queue.initialize();
    await t.test("concurrent schedulers and claims produce one task per direction and only one lease", async()=> {
      await reset();
      await Promise.all(Array.from({length:8}, ()=>queue.scheduleBenchmarks(benchmarkConfig)));
      assert.equal(await queue.tasks.countDocuments(),2);
      assert.deepEqual((await queue.tasks.findOne({sourceId:"a"}))!.payload.transports,[{name:"public",interface:"public"}]);
      const claims = await Promise.all(Array.from({length:8}, ()=>claimGateJob(context,{id:"a",name:"a"},"probe")));
      assert.equal(claims.filter(Boolean).length,1);
      assert.equal(await claimGateJob(context,{id:"b",name:"b"},"control"),null);
      assert.equal(await claimGateJob(context,{id:"c",name:"c"},"probe"),null);
      const job=claims.find(Boolean)!;
      assert.match(job.id,/^[a-f0-9-]{36}$/);
      const report={status:"succeeded" as const,actualStateHash:"",errorCode:"",resultSummary:{results:[{
        transport:"public",status:"succeeded",measuredAt:new Date().toISOString(),rttMs:{p50:8},samples:[{discard:"raw"}]
      }]}};
      assert.equal(await recordGateJobReport(context,"b",job.id,report),false);
      assert.equal(await recordGateJobReport(context,"a",job.id,report),true);
      assert.equal(await recordGateJobReport(context,"a",job.id,report),true);
      const pending=await queue.tasks.findOne({claimId:job.id});
      assert.equal(pending!.deliveryPending,true); assert.equal(pending!.expiresAt,undefined);
      assert.doesNotMatch(JSON.stringify(pending!.events),/samples|discard/);
      const restarted=new MongoProbeStore(measurements,prefix);
      await restarted.deliver(); await restarted.deliver();
      assert.equal((await measurements.benchmarks())[0]!.recent.length,1);
      assert.equal(await queue.tasks.countDocuments({deliveryPending:true}),0);
      assert.ok((await queue.tasks.findOne({claimId:job.id}))!.expiresAt instanceof Date);
      assert.equal(await queue.scheduleBenchmarks(benchmarkConfig),0);
      const matrix=await readPublicGateBenchmarkMatrix(context);
      assert.equal(matrix.gates.length,3); assert.equal(matrix.routes.length,2);
      assert.equal(matrix.routes[0]!.doublezeroApplicability?.status,"not_applicable");
    });
    await t.test("expired leases fence delayed reports and retry counts are bounded", async()=> {
      await reset(); await queue.scheduleBenchmarks(benchmarkConfig);
      const first=(await queue.claimGate("a","a"))!;
      await queue.tasks.updateOne({claimId:first.id},{$set:{leaseExpiresAt:new Date(Date.now()-1)}});
      const report={status:"succeeded" as const,actualStateHash:"",errorCode:"",resultSummary:{}};
      assert.equal(await queue.reportGate("a",first.id,report),false);
      await queue.reapExpired(); await queue.tasks.updateOne({sourceId:"a"},{$set:{runAfter:new Date(0)}});
      const second=(await queue.claimGate("a","a"))!;
      assert.notEqual(second.id,first.id); assert.equal(second.attemptNumber,2);
      assert.equal(await queue.reportGate("a",first.id,report),false);
      await queue.tasks.updateOne({claimId:second.id},{$set:{leaseExpiresAt:new Date(Date.now()-1)}});
      await queue.reapExpired();
      assert.equal((await queue.tasks.findOne({sourceId:"a"}))!.outcome,"dead");
      assert.equal(await queue.claimGate("a","a"),null);
    });
    await t.test("projection crash retains journal; replay after partial write does not double-count",async()=>{
      await reset(); await queue.scheduleBenchmarks(benchmarkConfig);
      const job=(await queue.claimGate("a","a"))!;
      await queue.reportGate("a",job.id,{status:"succeeded",actualStateHash:"",errorCode:"",resultSummary:{}});
      const deliver=measurements.deliver.bind(measurements);
      measurements.deliver=async (...args)=>{await deliver(...args);throw new Error("crash after write");};
      try {await assert.rejects(queue.deliver(),/journal retained/);} finally {measurements.deliver=deliver;}
      const pending=await queue.tasks.findOne({claimId:job.id});
      assert.equal(pending!.deliveryPending,true);assert.equal(pending!.expiresAt,undefined);assert.equal(pending!.deliveryAttempts,1);
      await queue.tasks.updateOne({claimId:job.id},{$set:{deliveryAfter:new Date(0)}});
      await new MongoProbeStore(measurements,prefix).deliver();
      const latest=(await measurements.benchmarks()).find(row=>row.sourceGateId==="a")!;
      assert.equal(new Set(latest.recent.map(row=>row.eventId)).size,latest.recent.length);
    });
    await t.test("trading auth, heartbeat, queue, old attempts, replay and public reads use Mongo only",async()=>{
      await reset();
      assert.equal((await authenticateTradingProbeToken(context,{nodeName:node.name,nodeToken:"token"}))!.id,node.id);
      assert.equal(await authenticateTradingProbeToken(context,{nodeName:node.name,nodeToken:"wrong"}),null);
      await recordTradingProbeHeartbeat(context,node,heartbeat);
      assert.equal(await queue.scheduleTrading(),1);
      const job=(await claimTradingProbeJob(context,node,"worker"))!;
      assert.equal(job.target.hostname,"example.invalid");
      assert.equal(await recordTradingProbeJobReport(context,node,job.id,job.attemptNumber+1,result()),false);
      assert.equal(await recordTradingProbeJobReport(context,node,job.id,job.attemptNumber,result()),true);
      assert.equal(await recordTradingProbeJobReport(context,node,job.id,job.attemptNumber,result()),true);
      await queue.deliver();
      const page=await readPublicTradingLatency(context,"cex","cex-test");
      assert.equal(page.nodes.length,1);assert.equal(page.targets.length,1);assert.equal(page.measurements.length,1);
      assert.equal(page.nodes[0]!.fresh,true);
      assert.equal(await queue.scheduleTrading(),0);
      const revoked=fixture();revoked.trading_probe_auth_tokens=[];
      await queue.replaceCatalog(revoked,new Date(Date.now()+1));
      assert.equal(await queue.authenticate({nodeName:node.name,nodeToken:"token"}),null);
      // A delayed catalog sync cannot resurrect the old token.
      await queue.replaceCatalog(fixture(),new Date(Date.now()-1000));
      assert.equal(await queue.authenticate({nodeName:node.name,nodeToken:"token"}),null);
    });
    await t.test("stale catalog fails closed; retired nodes/targets cancel work; unknown metro still tests DZ",async()=>{
      await reset(); const catalog=fixture();catalog.gate_status![1]!.doublezero_status.metro="";
      await queue.replaceCatalog(catalog,new Date(Date.now()+1));
      await queue.scheduleBenchmarks(benchmarkConfig);
      assert.equal((await queue.tasks.findOne({sourceId:"a"}))!.payload.transports.length,2);
      assert.equal((await listLatestGateBenchmarkRoutes(context))[0]!.doublezeroApplicability,undefined);
      catalog.gates![1]!.desired_state="Disabled";
      await queue.replaceCatalog(catalog,new Date(Date.now()+2));
      await queue.reapExpired();
      assert.equal(await queue.tasks.countDocuments({phase:"queued"}),0);
      await queue.collection("catalog").updateOne({_id:"current"},{$set:{capturedAt:new Date(Date.now()-61_000)}});
      await assert.rejects(queue.scheduleTrading(),/stale/);
      await assert.rejects(queue.authenticate({nodeName:node.name,nodeToken:"token"}),/stale/);
      await assert.rejects(queue.claimGate("a","a"),/stale/);
    });
    await t.test("indexes enforce active uniqueness and TTL only uses explicit expiry",async()=>{
      const indexes=await queue.tasks.indexes();
      assert.ok(indexes.some(index=>index.unique && index.partialFilterExpression?.active===true));
      assert.ok(indexes.some(index=>index.expireAfterSeconds===0 && index.key.expiresAt===1));
      assert.ok(!indexes.some(index=>index.expireAfterSeconds!==undefined && index.key.createdAt));
    });
  } finally {
    // Exact random test namespace only. Never drop a production collection.
    for(const name of ["jobs","schedule","node_status","catalog"]) await queue.collection(name).drop().catch(()=>{});
    for(const name of measurementNames) await originalCollection(name).drop().catch(()=>{});
    await measurements.close();
  }
});
