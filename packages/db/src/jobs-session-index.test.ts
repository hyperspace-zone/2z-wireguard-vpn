import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../migrations/0049_jobs_session_foreign_key_index.sql", import.meta.url);

test("session cleanup has a compact foreign-key-side jobs index", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /CREATE INDEX IF NOT EXISTS jobs_session_id_idx/);
  assert.match(sql, /ON jobs \(session_id\)/);
  assert.match(sql, /WHERE session_id IS NOT NULL/);
  assert.match(sql, /NOT indisvalid/);
});
