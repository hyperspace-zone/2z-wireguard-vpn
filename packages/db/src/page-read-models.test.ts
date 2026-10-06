import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("exact page read model backfills under the trigger lock and never alters raw usage", async () => {
  const sql = await readFile(new URL("../migrations/0055_page_read_models.sql", import.meta.url), "utf8");
  assert.match(sql, /AFTER INSERT ON gate_assignment_usage_deltas/);
  assert.match(sql, /ON CONFLICT \(assignment_id\) DO UPDATE/);
  assert.match(sql, /WHERE role = 'Egress' GROUP BY assignment_id/);
  assert.match(sql, /REFERENCES gate_assignments\(id\) ON DELETE CASCADE/);
  assert.ok(sql.indexOf("CREATE TRIGGER") < sql.lastIndexOf("FROM gate_assignment_usage_deltas"));
  assert.doesNotMatch(sql, /DELETE FROM|UPDATE gate_assignment_usage_deltas|UPDATE session_traffic_entitlements/);
});
