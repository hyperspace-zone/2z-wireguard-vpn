import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("billing indexes are additive, partial, and support concurrent preparation", async () => {
  const root = new URL("../../../", import.meta.url);
  const migration = await readFile(new URL("packages/db/migrations/0054_billing_read_indexes.sql", root), "utf8");
  const rollout = await readFile(new URL("scripts/control-plane/prebuild-billing-read-indexes.mjs", root), "utf8");
  assert.match(migration, /ON users \(account_id, created_at\) WHERE disabled_at IS NULL/);
  assert.match(migration, /ON gate_assignment_usage_deltas \(window_end, assignment_id\) WHERE role = 'Egress'/);
  assert.match(migration, /AND NOT indisvalid/);
  assert.match(rollout, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
  assert.doesNotMatch(migration, /DELETE FROM|DROP |UPDATE /);
});
