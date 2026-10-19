import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { mock } from "node:test";
import type { PoolClient } from "pg";
import { createDatabase } from "./index.js";

test("disconnect of a checked-out client does not become an uncaught process error", async () => {
  const db = createDatabase({ connectionString: "postgresql://localhost/unused", applicationName: "test" });
  try {
    const client = new EventEmitter() as PoolClient;
    db.pool.emit("connect", client);
    assert.doesNotThrow(() => client.emit("error", new Error("Connection terminated unexpectedly")));
    assert.doesNotThrow(() => db.pool.emit("error", new Error("Idle connection terminated")));
  } finally { await db.close(); }
});

test("lost connection preserves original transaction error, discards client and never retries", async () => {
  const db = createDatabase({ connectionString: "postgresql://localhost/unused", applicationName: "test" });
  const failure = new Error("Commit connection lost; outcome may be unknown");
  const released: unknown[] = [], queries: string[] = [];
  let calls = 0;
  const client = Object.assign(new EventEmitter(), {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql === "COMMIT") { client.emit("error", failure); throw failure; }
      if (sql === "ROLLBACK") throw new Error("Client is no longer queryable");
    },
    release: (error: unknown) => released.push(error)
  }) as unknown as PoolClient;
  db.pool.emit("connect", client);
  mock.method(db.pool, "connect", async () => client);
  try {
    await assert.rejects(db.transaction(async () => { calls++; return 1; }), error => error === failure);
    assert.equal(calls, 1);
    assert.deepEqual(queries, ["BEGIN", "COMMIT", "ROLLBACK"]);
    assert.equal(released[0], failure);
  } finally { await db.close(); }
});

test("application error with successful rollback keeps a healthy client reusable", async () => {
  const db = createDatabase({ connectionString: "postgresql://localhost/unused", applicationName: "test" });
  const released: unknown[] = [];
  const failure = new Error("Business rule rejected");
  const client = Object.assign(new EventEmitter(), {
    query: async () => undefined,
    release: (error: unknown) => released.push(error)
  }) as unknown as PoolClient;
  db.pool.emit("connect", client);
  mock.method(db.pool, "connect", async () => client);
  try {
    await assert.rejects(db.transaction(async () => { throw failure; }), error => error === failure);
    assert.deepEqual(released, [undefined]);
  } finally { await db.close(); }
});
