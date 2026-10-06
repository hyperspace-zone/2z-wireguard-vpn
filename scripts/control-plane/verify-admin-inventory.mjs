// Compare both read-only implementations in one database snapshot. Only counts
// and timings are printed; customer rows, SQL parameters and addresses are not.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const load = path => import(pathToFileURL(resolve(path)).href);
const { createDatabase } = await load("packages/db/dist/index.js");
const { listAdminBillingConfigs: current } = await load("packages/control-plane/dist/resources/billing/prepaid-repository.js");
if (!process.env.PAGE_BASELINE_RELEASE) throw new Error("PAGE_BASELINE_RELEASE must reference a preserved pre-change release");
const { listAdminBillingConfigs: baseline } = await load(`${process.env.PAGE_BASELINE_RELEASE}/packages/control-plane/dist/resources/billing/prepaid-repository.js`);
const db = createDatabase({ connectionString: process.env.DATABASE_URL, applicationName: "page-inventory-parity", maxConnections: 1, statementTimeoutMs: 10_000 });
const canonical = rows => rows.map(row => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))).sort();
try {
  await db.transaction(async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    for (const limit of [1, 25, 500]) {
      const oldRows = await baseline(client, limit);
      const newRows = await current(client, limit);
      assert.ok(JSON.stringify(canonical(newRows)) === JSON.stringify(canonical(oldRows)), "Inventory results must remain identical");
      console.log(JSON.stringify({ check: "inventory-parity", limit, rows: newRows.length, equal: true }));
    }
    for (const [name, read] of [["baseline", baseline], ["current", current]]) {
      let sql, values;
      await read({ query: async (text, params) => { sql = text; values = params; return { rows: [] }; } });
      const result = await client.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, values);
      const plan = result.rows[0]["QUERY PLAN"][0];
      console.log(JSON.stringify({ check: "inventory-plan", name, planningMs: plan["Planning Time"], executionMs: plan["Execution Time"] }));
    }
  });
} finally { await db.close(); }
