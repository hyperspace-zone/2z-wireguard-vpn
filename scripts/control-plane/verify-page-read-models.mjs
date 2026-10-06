// Real PostgreSQL verification in temporary tables, rolled back on every path.
// No production rows are read or changed; run with the API DATABASE_URL.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: "hyperspace-read-model-verification", max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(`CREATE TEMP TABLE accounts (id uuid PRIMARY KEY, created_at timestamptz);
    CREATE TEMP TABLE gate_assignments (id uuid PRIMARY KEY);
    CREATE TEMP TABLE gate_assignment_usage_deltas (
      sample_id text PRIMARY KEY, assignment_id uuid REFERENCES gate_assignments(id), role text,
      forwarded_to_destination_bytes bigint, forwarded_from_destination_bytes bigint,
      dropped_to_destination_bytes bigint, dropped_from_destination_bytes bigint,
      window_start timestamptz, window_end timestamptz
    ); SET LOCAL search_path = pg_temp, public`);
  const id = "00000000-0000-4000-8000-000000000055";
  await client.query("INSERT INTO gate_assignments VALUES ($1)", [id]);
  const insert = (sample, role, to, from, start, end) => client.query(`INSERT INTO gate_assignment_usage_deltas
    VALUES ($1,$2,$3,$4,$5,1,2,$6,$7) ON CONFLICT (sample_id) DO NOTHING`, [sample, id, role, to, from, start, end]);
  await insert("history", "Egress", 100, 50, "2026-01-02", "2026-01-03");
  await insert("ingress", "Ingress", 10000, 10000, "2026-01-01", "2026-01-04");
  const migration = await readFile(new URL("../../packages/db/migrations/0055_page_read_models.sql", import.meta.url), "utf8");
  await client.query(migration.replaceAll("accumulate_gate_assignment_usage", "pg_temp.accumulate_gate_assignment_usage"));
  await insert("new", "Egress", 20, 30, "2026-01-01", "2026-01-05");
  await insert("new", "Egress", 20, 30, "2026-01-01", "2026-01-05");
  const totals = (await client.query(`SELECT bytes_to_destination::text AS to_bytes,
    bytes_from_destination::text AS from_bytes, dropped_bytes::text AS dropped,
    first_traffic_at::text AS first, last_traffic_at::text AS last FROM gate_assignment_usage_totals`)).rows;
  assert.equal(totals.length, 1);
  assert.deepEqual([totals[0].to_bytes, totals[0].from_bytes, totals[0].dropped], ["120", "80", "6"]);
  assert.match(totals[0].first, /^2026-01-01/); assert.match(totals[0].last, /^2026-01-05/);
  await client.query("DELETE FROM gate_assignment_usage_deltas; DELETE FROM gate_assignments");
  assert.equal((await client.query("SELECT * FROM gate_assignment_usage_totals")).rowCount, 0);
  console.log(JSON.stringify({ ok: true, tests: ["backfill", "incremental insert", "duplicate report", "ingress excluded", "timestamp bounds", "assignment cascade"], productionRowsChanged: 0 }));
} finally {
  await client.query("ROLLBACK"); client.release(); await pool.end();
}
