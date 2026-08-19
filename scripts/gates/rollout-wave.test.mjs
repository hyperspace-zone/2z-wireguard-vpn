import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "rollout-wave.mjs");

test("rollout wave completes the selected canary before the remaining gates", () => {
  const directory = mkdtempSync(join(tmpdir(), "hyperspace-rollout-wave-"));
  const inventory = join(directory, "gates.json");
  writeFileSync(inventory, JSON.stringify([
    { name: "gate-eu-fra-21", publicIpv4: "192.0.2.10", desiredState: "Enabled", rolloutWave: 1 },
    { name: "gate-eu-lon-01", publicIpv4: "192.0.2.11", desiredState: "Enabled", rolloutWave: 1 }
  ]));

  const result = spawnSync(process.execPath, [
    script,
    "--inventory", inventory,
    "--wave", "1",
    "--canary-gate", "gate-eu-lon-01",
    "--control-plane-url", "https://control-plane.example.test",
    "--gate-token-dir", directory,
    "--probe-secret-file", join(directory, "probe.secret"),
    "--observability-ip", "192.0.2.20",
    "--dry-run"
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /rollout canary: gate-eu-lon-01/);
  const canaryOffset = result.stderr.indexOf("--gate-name gate-eu-lon-01");
  const remainingOffset = result.stderr.indexOf("--gate-name gate-eu-fra-21");
  assert.ok(canaryOffset >= 0 && remainingOffset > canaryOffset, result.stderr);
  assert.match(result.stderr, /validate-host .*--require-deployment-ready/);
});
