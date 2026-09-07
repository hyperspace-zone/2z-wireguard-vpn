import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const migrationUrl = new URL("packages/db/migrations/0040_trading_latency_perpdex_expansion.sql", root);
const venues = [
  ["variational-omni-stats", "variational", "omni-client-api.prod.ap-northeast-1.variational.io", "/metadata/stats"],
  ["extended-perpetuals-rest", "extended", "api.starknet.extended.exchange", "/api/v1/info/markets?market=BTC-USD"],
  ["rise-perpetuals-rest", "rise", "api.rise.trade", "/v1/markets"],
  ["lighter-perpetuals-rest", "lighter", "mainnet.zklighter.elliot.ai", "/api/v1/orderBookDetails?market_id=1"]
] as const;

test("perpDEX catalog uses four public mainnet APIs with bounded read-only probes", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  for (const [key, category, host, path] of venues) {
    assert.ok(migration.includes(`'${key}', '${category}'`));
    assert.ok(migration.includes(`'${host}', '${path}', 'GET'`));
  }
  assert.equal((migration.match(/'json_object', 60, 5000, 3, true/g) ?? []).length, 4);
  assert.equal((migration.match(/"readOnly":true/g) ?? []).length, 4);
  assert.equal((migration.match(/"venueType":"perpdex"/g) ?? []).length, 4);
  assert.equal((migration.match(/not execution latency/g) ?? []).length, 4);
  assert.doesNotMatch(migration, /authorization|api[_-]?key|secret|'POST'|testnet\./i);
  assert.match(migration, /ON CONFLICT \(target_key\) DO UPDATE SET/);
});

test("every new API host is explicitly allowed by both agent defaults and deployment template", async () => {
  const agent = await readFile(new URL("apps/trading-probe-agent/cmd/hyperspace-trading-probe-agent/main.go", root), "utf8");
  const environment = await readFile(new URL("infra/systemd/trading-probe-agent.env.example", root), "utf8");
  const allowlist = environment.split("\n").find((line) => line.startsWith("TRADING_PROBE_ALLOWED_HOSTS="))?.split("=")[1]?.split(",");
  for (const [, , host] of venues) {
    assert.ok(agent.includes(`"${host}"`), host);
    assert.ok(allowlist?.includes(host), host);
  }
});
