import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../migrations/0039_trading_latency_cex_expansion.sql", import.meta.url);

test("trading CEX expansion covers the complete Glassnode venue set", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  for (const target of [
    "bitget-spot-rest",
    "bitstamp-spot-rest",
    "bullish-spot-rest",
    "bybit-spot-rest",
    "coinbase-spot-rest",
    "deribit-derivatives-rest",
    "okx-spot-rest",
    "upbit-spot-rest"
  ]) {
    assert.match(migration, new RegExp(`'${target}'`));
  }

  assert.doesNotMatch(migration, /authorization|api[_-]?key|secret/i);
  assert.match(migration, /'json_array'/);
  assert.match(migration, /"readOnly":true/g);
});
