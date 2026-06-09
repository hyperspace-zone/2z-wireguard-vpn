import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable } from "../../db/queryable.js";
import { authenticatePublicAuthSession } from "./service.js";

test("public auth session authentication hashes token and marks valid sessions seen", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const user = {
    id: "user-1",
    accountId: "account-1",
    email: "user@example.com",
    displayName: "User"
  };
  const db: Queryable = {
    async query<Row extends object>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("FROM auth_sessions")) {
        return { rows: [user as Row], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  };

  const result = await authenticatePublicAuthSession(db, "secret-token");

  assert.deepEqual(result, user);
  assert.equal(calls.length, 2);
  const [lookup, seenUpdate] = calls;
  assert.ok(lookup);
  assert.ok(seenUpdate);
  assert.match(lookup.sql, /FROM auth_sessions/);
  assert.match(seenUpdate.sql, /last_seen_at/);
  assert.equal(lookup.params[0], seenUpdate.params[0]);
  assert.notEqual(lookup.params[0], "secret-token");
});

test("public auth session authentication does not mark missing sessions seen", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db: Queryable = {
    async query<Row extends object>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [] as Row[], rowCount: 0 };
    }
  };

  const result = await authenticatePublicAuthSession(db, "missing-token");

  assert.equal(result, null);
  assert.equal(calls.length, 1);
  const [lookup] = calls;
  assert.ok(lookup);
  assert.match(lookup.sql, /FROM auth_sessions/);
});
