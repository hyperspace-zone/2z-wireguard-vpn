#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");

const args = parseArgs(process.argv.slice(2));
if (!args.inventory || !args.wave || !args.controlPlaneUrl || !args.gateTokenDir || !args.probeSecretFile || args.observabilityIps.length === 0) {
  usage();
  process.exit(2);
}

const inventory = JSON.parse(readFileSync(args.inventory, "utf8"));
if (!Array.isArray(inventory)) {
  throw new Error("inventory must be a JSON array");
}

const gates = inventory.filter((gate) => {
  const wave = gate.rolloutWave ?? gate.wave;
  const desiredState = gate.desiredState ?? "Disabled";
  return String(wave) === String(args.wave) && desiredState !== "Removed";
});

if (gates.length === 0) {
  console.error(`no gates found for rollout wave ${args.wave}`);
  process.exit(1);
}

const dryRun = args.dryRun !== false;
const sshKeyArgs = args.sshKey ? ["--ssh-key", args.sshKey] : [];
const sshUserArgs = args.sshUser ? ["--ssh-user", args.sshUser] : [];
const knownHostsArgs = args.knownHostsFile ? ["--known-hosts-file", args.knownHostsFile] : [];
const benchmarkPeerIps = [...new Set(inventory
  .filter((gate) => (gate.desiredState ?? "Disabled") !== "Removed")
  .map((gate) => gate.publicIpv4)
  .filter((address) => typeof address === "string" && address.length > 0))];
if (benchmarkPeerIps.length === 0) {
  throw new Error("inventory must contain at least one non-removed gate publicIpv4");
}

for (const gate of gates) {
  const host = gate.sshHost || gate.publicIpv4 || gate.probeHost || gate.name;
  const name = gate.name;
  const dzEnv = gate.doubleZeroEnv || args.doublezeroEnv || "mainnet-beta";
  const gateHost = gate.gateHost || gate.fqdn || gate.probeHost || (typeof gate.probeUrl === "string" ? new URL(gate.probeUrl).hostname : "");
  if (!host || !name) {
    throw new Error(`gate entry is missing host or name: ${JSON.stringify(gate)}`);
  }
  const tokenFile = resolve(args.gateTokenDir, `${name}.token`);
  if (!dryRun && !existsSync(tokenFile)) {
    throw new Error(`missing gate token file: ${tokenFile}`);
  }

  run("bootstrap-host", [
    "--host", host,
    "--doublezero-env", dzEnv,
    ...sshKeyArgs,
    ...sshUserArgs,
    ...knownHostsArgs,
    ...(gate.resourceTier ? ["--tier", gate.resourceTier] : []),
    ...(args.doublezeroVersion ? ["--doublezero-version", args.doublezeroVersion] : []),
    ...args.observabilityIps.flatMap((address) => ["--observability-ip", address]),
    ...benchmarkPeerIps.flatMap((address) => ["--benchmark-peer-ip", address]),
    ...(dryRun ? ["--dry-run"] : [])
  ]);

  run("deploy-agent", [
    "--host", host,
    "--gate-name", name,
    "--control-plane-url", args.controlPlaneUrl,
    "--gate-token-file", tokenFile,
    "--probe-secret-file", args.probeSecretFile,
    ...sshKeyArgs,
    ...sshUserArgs,
    ...knownHostsArgs,
    ...(gateHost && args.webOrigins.length > 0
      ? ["--gate-host", gateHost, ...args.webOrigins.flatMap((origin) => ["--web-origin", origin])]
      : []),
    ...(args.binary ? ["--binary", args.binary] : []),
    ...(dryRun ? ["--dry-run"] : [])
  ]);

  run("validate-host", [
    "--host", host,
    "--doublezero-env", dzEnv,
    ...sshKeyArgs,
    ...sshUserArgs,
    ...knownHostsArgs,
    ...(dryRun ? ["--dry-run"] : [])
  ]);
}

function run(script, scriptArgs) {
  const command = resolve(scriptDir, script);
  console.error(`\n==> ${script} ${scriptArgs.join(" ")}`);
  const result = spawnSync(command, scriptArgs, {
    cwd: repoRoot,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function parseArgs(argv) {
  const out = { dryRun: true, observabilityIps: [], webOrigins: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--inventory":
        out.inventory = argv[++i];
        break;
      case "--wave":
        out.wave = argv[++i];
        break;
      case "--ssh-key":
        out.sshKey = argv[++i];
        break;
      case "--ssh-user":
        out.sshUser = argv[++i];
        break;
      case "--known-hosts-file":
        out.knownHostsFile = argv[++i];
        break;
      case "--control-plane-url":
        out.controlPlaneUrl = argv[++i];
        break;
      case "--web-origin":
        out.webOrigins.push(argv[++i]);
        break;
      case "--gate-token-dir":
        out.gateTokenDir = argv[++i];
        break;
      case "--probe-secret-file":
        out.probeSecretFile = argv[++i];
        break;
      case "--doublezero-env":
        out.doublezeroEnv = argv[++i];
        break;
      case "--doublezero-version":
        out.doublezeroVersion = argv[++i];
        break;
      case "--observability-ip":
        out.observabilityIps.push(argv[++i]);
        break;
      case "--binary":
        out.binary = argv[++i];
        break;
      case "--execute":
        out.dryRun = false;
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function usage() {
  console.error(`usage: scripts/gates/rollout-wave.mjs --inventory gates.json --wave WAVE --control-plane-url URL --gate-token-dir DIR --probe-secret-file FILE --observability-ip IPV4 [--observability-ip IPV4 ...] [--web-origin URL ...] [--execute]

Default mode is dry-run. Use --execute only after reviewing the rendered host commands.
Inventory entries are selected by rolloutWave or wave and can include sshHost, publicIpv4,
name, fqdn, probeUrl, doubleZeroEnv, and desiredState. All non-removed publicIpv4
values become the persistent UDP/19192 gate-peer allowlist.`);
}
