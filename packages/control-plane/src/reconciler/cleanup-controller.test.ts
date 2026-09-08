import assert from "node:assert/strict";
import test from "node:test";
import type { TransactionalQueryable } from "../db/queryable.js";
import { runCleanupTasks } from "./cleanup-controller.js";

test("worker cleanup leaves durable operational history to the verified NFS archiver", async () => {
  const statements: string[] = [];
  const db: TransactionalQueryable = {
    async query<Row extends object>() {
      return { rows: [] as Row[], rowCount: 0 };
    },
    async transaction<T>(fn: (client: TransactionalQueryable) => Promise<T>): Promise<T> {
      const client: TransactionalQueryable = {
        query: async <Row extends object>(sql: string) => {
          statements.push(sql);
          return { rows: [] as Row[], rowCount: 0 };
        },
        transaction: async <Value>(nested: (inner: TransactionalQueryable) => Promise<Value>) => nested(client)
      };
      return fn(client);
    }
  };

  const result = await runCleanupTasks(db);
  assert.equal(result.tradingProbeJobsDeleted, 0);
  assert.equal(result.tradingProbeRollupsDeleted, 0);
  assert.doesNotMatch(statements.join("\n"), /DELETE FROM trading_probe_jobs|DELETE FROM trading_latency_rollups/);
});
