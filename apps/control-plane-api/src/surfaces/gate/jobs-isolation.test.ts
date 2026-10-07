import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "@hyperspace-zone/db";
import { registerGateJobRoutes } from "./jobs.routes.js";

const gate = { id: "00000000-0000-4000-8000-000000000010", name: "gate-test", generation: 1, desiredState: "Enabled" as const, publicIpv4: "192.0.2.10", spec: {} };
function setup(core: Database, probes: Database) {
  const app = Fastify();
  registerGateJobRoutes(app, { db: core, probesDb: probes, requireGate: async () => gate });
  return app;
}
test("control claims do not touch a completely unavailable probes database", async () => {
  let probesCalls=0;
  const core = { transaction: async (fn: (client: unknown) => Promise<unknown>) => fn({ query: async (_sql: string, params: unknown[]) => { assert.equal(params[1], "control"); return { rows: [] }; } }) } as unknown as Database;
  const probes = { transaction: async () => { probesCalls++; throw new Error("probes offline"); } } as unknown as Database;
  const app=setup(core,probes);
  try {
    for (const payload of [{ lane: "control" }, {}]) {
      const response=await app.inject({ method:"POST",url:"/v1/gate/jobs/claim",payload });
      assert.equal(response.statusCode,200); assert.deepEqual(response.json(),{job:null});
    }
    assert.equal(probesCalls,0);
  } finally { await app.close(); }
});
test("a successful operational report does not depend on probes", async () => {
  let probesCalls=0;
  const core = { transaction: async (fn: (client: unknown) => Promise<unknown>) => fn({ query: async (sql: string) => ({ rows: sql.includes("FROM jobs") ? [{ id: gate.id, type:"reconcile",gateId:gate.id,assignmentId:null,retryCount:0,maxRetries:5,payload:{} }] : [] }) }) } as unknown as Database;
  const probes={transaction:async()=>{probesCalls++;throw new Error("probes offline");}} as unknown as Database;
  const app=setup(core,probes);
  try {
    const response=await app.inject({method:"POST",url:`/v1/gate/jobs/${gate.id}/report`,payload:{status:"succeeded",resultSummary:{}}});
    assert.equal(response.statusCode,200,response.body);assert.equal(probesCalls,0);
  } finally { await app.close(); }
});
test("synthetic claims are sent only to probes", async () => {
  let probeCalls=0;
  const core={transaction:async()=>{throw new Error("core queue must not be queried");}} as unknown as Database;
  const probes={transaction:async(fn:(c:unknown)=>Promise<unknown>)=>fn({query:async()=>{probeCalls++;return{rows:[]};}})} as unknown as Database;
  const app=setup(core,probes);
  try { assert.equal((await app.inject({method:"POST",url:"/v1/gate/jobs/claim",payload:{lane:"probe"}})).statusCode,200); assert.equal(probeCalls,1); }
  finally {await app.close();}
});
