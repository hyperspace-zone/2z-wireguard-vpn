import assert from "node:assert/strict";
import test from "node:test";
import type { Queryable } from "../db/queryable.js";
import { sha256Hex } from "./tokens.js";
import { authenticateTradingProbeToken } from "./trading-probe-auth.js";

test("trading probe authentication hashes the token and uses probe-only tables", async () => {
  let statement = "";
  let values: readonly unknown[] = [];
  const db = {
    query: async (sql: string, params?: readonly unknown[]) => {
      statement = sql;
      values = params ?? [];
      return {
        rows: [{ id: "node-1", name: "probe-ams", generation: 1, desiredState: "Enabled" }]
      };
    }
  } as Queryable;
  const result = await authenticateTradingProbeToken(db, { nodeName: "probe-ams", nodeToken: "secret" });
  assert.equal(result?.id, "node-1");
  assert.match(statement, /trading_probe_auth_tokens/);
  assert.doesNotMatch(statement, /gate_auth_tokens/);
  assert.deepEqual(values, ["probe-ams", sha256Hex("secret")]);
});
