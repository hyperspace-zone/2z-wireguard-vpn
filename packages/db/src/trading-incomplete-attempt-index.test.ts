import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../migrations/0050_trading_incomplete_attempt_index.sql", import.meta.url);

test("incomplete trading attempts have a small reconciliation index", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /CREATE INDEX IF NOT EXISTS trading_probe_job_attempts_incomplete_job_idx/);
  assert.match(sql, /ON trading_probe_job_attempts \(job_id\)/);
  assert.match(sql, /WHERE completed_at IS NULL/);
  assert.doesNotMatch(sql, /completed_at IS NOT NULL/);
});
