import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../migrations/0038_trading_latency_target_expansion.sql", import.meta.url);

test("trading expansion covers every network and public oracle adapter", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  for (const target of [
    "sui-mainnet-graphql",
    "robinhood-chain-mainnet-rpc",
    "base-mainnet-rpc",
    "xlayer-mainnet-rpc",
    "ink-mainnet-rpc",
    "op-mainnet-rpc",
    "zksync-era-mainnet-rpc",
    "pyth-lazer-router-0",
    "pyth-lazer-router-1",
    "pyth-lazer-router-2",
    "switchboard-crossbar-health",
    "chainlink-data-streams-health"
  ]) {
    assert.match(migration, new RegExp(`'${target}'`));
  }
  assert.match(migration, /'tcp_tls', 'tls'/);
  assert.match(migration, /'transactionSubmission':false|"transactionSubmission":false/);
});
