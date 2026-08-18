import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "bootstrap-host");

test("bootstrap renders persistent observability and benchmark UFW allowlists", () => {
  const result = spawnSync(script, [
    "--host", "gate.example.test",
    "--doublezero-env", "mainnet-beta",
    "--observability-ip", "192.0.2.10",
    "--benchmark-peer-ip", "198.51.100.20",
    "--benchmark-peer-ip", "198.51.100.21",
    "--dry-run"
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OBSERVABILITY_IPS=.*192\.0\.2\.10/);
  assert.match(result.stdout, /BENCHMARK_PEER_IPS=.*198\.51\.100\.20.*198\.51\.100\.21/);
  assert.match(result.stdout, /hyperspace-gate-firewall\.service/);
  assert.match(result.stdout, /hyperspace-gate-firewall --check/);
});

test("bootstrap rejects an invalid firewall source", () => {
  const result = spawnSync(script, [
    "--host", "gate.example.test",
    "--doublezero-env", "mainnet-beta",
    "--observability-ip", "not-an-ip",
    "--benchmark-peer-ip", "198.51.100.20",
    "--dry-run"
  ], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid firewall source IPv4/);
});
