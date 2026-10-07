import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
test("probes base schema cannot contain or accept VPN or financial jobs",async()=>{
  const source=await readFile(new URL("../probes-migrations/0001_probes_instance.sql",import.meta.url),"utf8");
  assert.doesNotMatch(source,/CREATE TABLE (users|sessions|payments|custodial_wallets|gate_assignments|balance_ledger_entries)\b/);
  assert.match(source,/job_type AS ENUM \('probe'\)/);
  assert.match(source,/CHECK\(session_id IS NULL\)/);
  assert.match(source,/CHECK\(assignment_id IS NULL\)/);
});
