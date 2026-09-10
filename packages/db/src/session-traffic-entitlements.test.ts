import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../migrations/0051_session_traffic_entitlements.sql", import.meta.url);

test("paid config traffic allowance is additive and leaves legacy sessions unmetered", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(migration, /ADD COLUMN IF NOT EXISTS traffic_limit_bytes bigint/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS session_traffic_entitlements/);
  assert.match(migration, /session_id uuid PRIMARY KEY REFERENCES sessions\(id\) ON DELETE CASCADE/);
  assert.match(migration, /included_bytes bigint NOT NULL CHECK \(included_bytes > 0\)/);
  assert.match(migration, /consumed_bytes bigint NOT NULL DEFAULT 0 CHECK \(consumed_bytes >= 0\)/);
  assert.match(migration, /WHERE exhausted_at IS NULL AND consumed_bytes >= included_bytes/);
  assert.doesNotMatch(migration, /INSERT INTO session_traffic_entitlements[\s\S]+SELECT/);
});
