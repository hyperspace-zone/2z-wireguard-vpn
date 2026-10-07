import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "@hyperspace-zone/db";
import { registerPublicBenchmarkRoutes } from "./benchmarks.routes.js";
import { registerPublicTradingRoutes } from "./trading.routes.js";
import { attachMeasurementStore } from "@hyperspace-zone/control-plane";

test("measurement outage returns bounded 503 without exposing SQL or breaking unrelated routes",async()=>{
  const app=Fastify();
  const unavailable={query:async()=>{throw new Error("secret postgres credentials/SQL should never be sent");}} as unknown as Database;
  registerPublicBenchmarkRoutes(app,{db:unavailable});
  registerPublicTradingRoutes(app,{db:unavailable});
  app.get("/core-check",async()=>({ok:true}));
  try {
    for(const url of ["/v1/public/benchmarks/gate-matrix","/v1/public/trading/latency"]){
      const response=await app.inject({url});
      assert.equal(response.statusCode,503,response.body);
      assert.equal(response.headers["retry-after"],"10");
      assert.doesNotMatch(response.body,/credentials|postgres|SELECT/);
    }
    assert.equal((await app.inject({url:"/core-check"})).statusCode,200);
  } finally {await app.close();}
});

test("Mongo outage leaves PostgreSQL available and redacts driver errors while core routes stay healthy",async()=>{
  const app=Fastify();
  const db={query:async()=>({rows:[],rowCount:0}),transaction:async()=>{throw new Error("Unexpected mutation during read");}} as unknown as Database;
  const unavailable=async()=>{throw new Error("mongodb://user:secret@example.invalid credentials");};
  attachMeasurementStore(db,{initialize:unavailable,deliver:unavailable,benchmarks:unavailable,trading:unavailable,close:async()=>{}});
  registerPublicBenchmarkRoutes(app,{db});registerPublicTradingRoutes(app,{db});
  app.get('/core-check',async()=>({ok:true}));
  try{
    await app.ready();
    for(const url of ['/v1/public/benchmarks/gate-matrix','/v1/public/trading/latency']){
      const r=await app.inject({url});assert.equal(r.statusCode,503);assert.doesNotMatch(r.body,/secret|mongodb|credentials|example/);
    }
    assert.equal((await app.inject({url:'/core-check'})).statusCode,200);
  }finally{await app.close();}
});
