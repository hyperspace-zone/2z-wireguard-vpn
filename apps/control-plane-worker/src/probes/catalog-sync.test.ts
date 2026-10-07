import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "@hyperspace-zone/db";
import { syncProbesCatalog, catalogMirrors } from "./catalog-sync.js";
test("catalog replication commits its read-only core snapshot before a probes transaction",async()=>{
  const events:string[]=[];
  const core={transaction:async(fn:(client:unknown)=>Promise<unknown>)=>{events.push("core-begin");const result=await fn({query:async(sql:string)=>{events.push(sql);return{rows:[]};}});events.push("core-end");return result;}} as unknown as Database;
  const probes={transaction:async(fn:(client:unknown)=>Promise<unknown>)=>{events.push("probes-begin");return fn({query:async(sql:string)=>({rows:sql.includes("information_schema")?[{column_name:"id"},{column_name:"gate_id"},{column_name:"phase"}]:[]})});}} as unknown as Database;
  await syncProbesCatalog(core,probes);
  assert.ok(events.indexOf("core-end")<events.indexOf("probes-begin"));
  assert.match(events.join("\n"),/REPEATABLE READ, READ ONLY/);
  assert.doesNotMatch(events.join("\n"),/PREPARE TRANSACTION|INSERT INTO|UPDATE /);
  assert.ok(!catalogMirrors.some(m=>/wallet|user|payment|session|ledger/.test(m.table)));
});
test("an unavailable destination never writes back to core",async()=>{
  let queries=0;
  const core={transaction:async(fn:(c:unknown)=>Promise<unknown>)=>fn({query:async(sql:string)=>{assert.doesNotMatch(sql,/INSERT|UPDATE|DELETE/);queries++;return{rows:[]};}})} as unknown as Database;
  const probes={transaction:async()=>{throw new Error("down");}} as unknown as Database;
  await assert.rejects(syncProbesCatalog(core,probes),/down/);assert.ok(queries>0);
});
test("retired gate-host probes are disabled only locally, not standalone probes or core",async()=>{
  const writes:string[]=[];
  const core={transaction:async(fn:(c:unknown)=>Promise<unknown>)=>fn({query:async(sql:string)=>{assert.doesNotMatch(sql,/UPDATE |DELETE |INSERT /);return{rows:[]};}})} as unknown as Database;
  const probes={transaction:async(fn:(c:unknown)=>Promise<unknown>)=>fn({query:async(sql:string)=>{writes.push(sql);return{rows:sql.includes("information_schema")?[{column_name:"id"}]:[]};}})} as unknown as Database;
  await syncProbesCatalog(core,probes);
  const retired=writes.find(sql=>sql.includes("nodes.placement_kind='gate_host'"));
  assert.ok(retired);
  assert.match(retired,/gates.desired_state='Disabled'/);
  assert.match(retired,/SET desired_state='Disabled'/);
});
