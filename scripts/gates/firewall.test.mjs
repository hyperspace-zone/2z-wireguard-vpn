import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const firewallScript = join(repoRoot, "scripts/hyperspace-gate-firewall.sh");

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hyperspace-gate-firewall-"));
  const config = join(directory, "gate-firewall.env");
  const fakeUfw = join(directory, "ufw");
  const log = join(directory, "ufw.log");
  writeFileSync(config, [
    'OBSERVABILITY_IPS="192.0.2.10"',
    'BENCHMARK_PEER_IPS="198.51.100.20 198.51.100.21"',
    "NODE_EXPORTER_PORT=9100",
    "BENCHMARK_PROBE_PORT=19192",
    ""
  ].join("\n"));
  writeFileSync(fakeUfw, `#!/usr/bin/env bash
set -euo pipefail
case "\${*}" in
  "show added") printf '%s\\n' "\${FAKE_UFW_RULES:-}" ;;
  "status") printf '%s\\n' "Status: inactive" ;;
  *) printf '%s\\n' "\${*}" >>"\${FAKE_UFW_LOG}" ;;
esac
`);
  chmodSync(fakeUfw, 0o755);
  return { config, fakeUfw, log };
}

function runFirewall(args, files, rules = "") {
  return spawnSync(firewallScript, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      HYPERSPACE_GATE_FIREWALL_CONFIG: files.config,
      HYPERSPACE_UFW_BIN: files.fakeUfw,
      FAKE_UFW_LOG: files.log,
      FAKE_UFW_RULES: rules
    }
  });
}

test("gate firewall applies scoped rules for all configured sources", () => {
  const files = fixture();
  const result = runFirewall([], files);

  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(files.log, "utf8");
  assert.match(calls, /allow from 192\.0\.2\.10 to any port 9100 proto tcp/);
  assert.match(calls, /allow from 198\.51\.100\.20 to any port 19192 proto udp/);
  assert.match(calls, /allow from 198\.51\.100\.21 to any port 19192 proto udp/);
});

test("gate firewall check requires every persisted rule", () => {
  const files = fixture();
  const rules = [
    "ufw allow from 192.0.2.10 to any port 9100 proto tcp comment 'hyperspace-observability'",
    "ufw allow from 198.51.100.20 to any port 19192 proto udp comment 'hyperspace-benchmark'",
    "ufw allow from 198.51.100.21 to any port 19192 proto udp comment 'hyperspace-benchmark'"
  ].join("\n");

  const success = runFirewall(["--check"], files, rules);
  assert.equal(success.status, 0, success.stderr);

  const failure = runFirewall(["--check"], files, rules.replace(/^.*198\.51\.100\.21.*\n?/m, ""));
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /missing persistent UFW rule: 198\.51\.100\.21 udp\/19192/);
});
