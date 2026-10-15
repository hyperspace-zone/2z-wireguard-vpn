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

for (const flavor of ["auto", "aws", "hwe"]) {
  test(`bootstrap accepts ${flavor} kernel track and prepares swap before DKMS`, () => {
    const result = spawnSync(script, [
      "--host", "gate.example.test", "--doublezero-env", "mainnet-beta",
      "--observability-ip", "192.0.2.10", "--benchmark-peer-ip", "198.51.100.20",
      "--kernel-flavor", flavor, "--dry-run"
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`KERNEL_FLAVOR=${flavor}`));
    assert.match(result.stdout, /\*-aws\) KERNEL_FLAVOR=aws/);
    assert.match(result.stdout, /apt-get install -y linux-aws linux-headers-aws/);
    const remote = result.stdout.slice(result.stdout.indexOf("set -euo pipefail"));
    assert.ok(remote.indexOf("swapon /swapfile") < remote.indexOf('bash "$ASSET_DIR/scripts/gates/install-amneziawg"'));
    assert.ok(remote.indexOf("apt-get install -y linux-aws") < remote.indexOf('bash "$ASSET_DIR/scripts/gates/install-amneziawg"'));
    assert.equal(spawnSync("bash", ["-n"], { input: remote.replace(/\nREMOTE\n$/, ""), encoding: "utf8" }).status, 0);
    // Bootstrap must not connect before the operator verifies an access-pass.
    assert.doesNotMatch(remote, /doublezero\s+connect/);
  });
}

test("bootstrap rejects an unknown kernel track before SSH", () => {
  const result = spawnSync(script, [
    "--host", "gate.example.test", "--doublezero-env", "mainnet-beta",
    "--kernel-flavor", "other", "--dry-run"
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unsupported --kernel-flavor/);
});

test("bootstrap can pin daemon IPv4 without enabling a DoubleZero connection", () => {
  const result = spawnSync(script, [
    "--host", "gate.example.test", "--doublezero-env", "mainnet-beta",
    "--observability-ip", "192.0.2.10", "--benchmark-peer-ip", "198.51.100.20",
    "--public-ipv4", "203.0.113.10", "--dry-run"
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PUBLIC_IPV4=203\.0\.113\.10/);
  assert.ok(result.stdout.includes('client_ip_argument=" -client-ip ${PUBLIC_IPV4}"'));
  assert.match(result.stdout, /test -S \/run\/doublezerod\/doublezerod.sock/);
  assert.doesNotMatch(result.stdout, /doublezero\s+connect/);
});

test("bootstrap rejects malformed explicit IPv4 before SSH", () => {
  const result = spawnSync(script, [
    "--host", "gate.example.test", "--doublezero-env", "mainnet-beta",
    "--observability-ip", "192.0.2.10", "--benchmark-peer-ip", "198.51.100.20",
    "--public-ipv4", "203.0.113.999", "--dry-run"
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid --public-ipv4/);
});

for (const [requested, running, hweAvailable, expected] of [
  ['auto', '7.0.0-1014-aws', true, 'linux-aws linux-headers-aws'],
  ['auto', '7.0.0-38-generic', true, 'linux-generic-hwe-24.04'],
  ['aws', '7.0.0-38-generic', true, 'linux-aws linux-headers-aws'],
  ['hwe', '7.0.0-1014-aws', true, 'linux-generic-hwe-24.04'],
  ['hwe', 'other', false, 'linux-generic']
]) {
  test(`kernel selector: ${requested}/${running}/${hweAvailable}`, () => {
    const rendered = spawnSync(script, [
      '--host', 'gate.example.test', '--doublezero-env', 'mainnet-beta',
      '--observability-ip', '192.0.2.10', '--benchmark-peer-ip', '198.51.100.20', '--dry-run'
    ], { encoding: 'utf8' }).stdout;
    const selector = rendered.slice(rendered.indexOf('if [ "$KERNEL_FLAVOR" = auto ]'), rendered.indexOf('# New gates support'));
    assert.ok(selector.length > 0);
    const result = spawnSync('bash', ['-s'], {
      input: `set -euo pipefail\nuname() { echo '${running}'; }\napt-cache() { return ${hweAvailable ? 0 : 1}; }\napt-get() { printf '%s\\n' "$*"; }\n${selector}`,
      env: { ...process.env, KERNEL_FLAVOR: requested }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `install -y ${expected}`);
  });
}
