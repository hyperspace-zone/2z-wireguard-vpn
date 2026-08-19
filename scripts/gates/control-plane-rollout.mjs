#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const activePhases = new Set(["queued", "staging", "verifying", "rollback_requested", "rolling_back"]);
const options = parseArgs(process.argv.slice(2));
if (options.inventory) {
  if (options.wave === undefined) throw new Error("--inventory requires --wave to bound the rollout");
  const inventory = JSON.parse(await readFile(options.inventory, "utf8"));
  if (!Array.isArray(inventory)) throw new Error("inventory must be a JSON array");
  options.gates.push(...inventory
    .filter((gate) => (gate.desiredState || "Disabled") !== "Removed")
    .filter((gate) => options.wave === undefined || String(gate.rolloutWave ?? gate.wave) === String(options.wave))
    .map((gate) => gate.name)
    .filter((name) => typeof name === "string" && name.length > 0));
}
if (!options.binary || !options.controlPlaneUrl || !options.adminTokenFile || options.gates.length === 0) {
  usage();
  process.exit(2);
}

const binary = resolve(options.binary);
const data = await readFile(binary);
const artifactSha256 = createHash("sha256").update(data).digest("hex");
const build = JSON.parse(execFileSync(binary, ["--build-info"], { encoding: "utf8", timeout: 10_000 }));
if (
  build.artifactSha256 !== artifactSha256
  || !/^[a-f0-9]{40}$/.test(build.revision || "")
  || !build.version
  || !build.builtAt
) {
  throw new Error("binary --build-info does not match its immutable SHA-256 or required release metadata");
}
execFileSync(binary, ["--self-test"], { stdio: "ignore", timeout: 30_000 });
const releaseInput = {
  version: build.version,
  revision: build.revision,
  builtAt: build.builtAt,
  artifactSha256
};

const orderedNames = orderCanary([...new Set(options.gates)], options.canaryGate);
if (!options.execute) {
  process.stdout.write(`${JSON.stringify({
    mode: "dry-run",
    artifact: releaseInput,
    releaseDir: options.releaseDir,
    canary: orderedNames[0],
    gates: orderedNames
  }, null, 2)}\n`);
  process.exit(0);
}

const adminToken = (await readFile(options.adminTokenFile, "utf8")).trim();
if (!adminToken) throw new Error("admin token file is empty");
await stageArtifact(options.releaseDir, artifactSha256, data);

const releaseResponse = await api("/v1/admin/gate-agent/releases", {
  method: "POST",
  body: releaseInput
});
const release = releaseResponse.release;
const gatesResponse = await api("/v1/admin/gates");
const gatesByName = new Map(gatesResponse.gates.map((gate) => [gate.name, gate]));
const results = [];

for (const name of orderedNames) {
  const gate = gatesByName.get(name);
  if (!gate) throw new Error(`gate is absent from the control-plane catalog: ${name}`);
  const created = await api(`/v1/admin/gates/${gate.id}/agent-deployments`, {
    method: "POST",
    body: { releaseId: release.id }
  });
  const terminal = await waitForDeployment(created.deployment.id, gate.id);
  results.push({ gate: name, deploymentId: terminal.id, phase: terminal.phase });
  if (terminal.phase !== "succeeded") {
    throw new Error(`rollout stopped at ${name}: deployment ended in ${terminal.phase}`);
  }
}

process.stdout.write(`${JSON.stringify({ artifact: releaseInput, releaseId: release.id, deployments: results }, null, 2)}\n`);

async function waitForDeployment(deploymentId, gateId) {
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const response = await api(`/v1/admin/gate-agent/deployments?gateId=${encodeURIComponent(gateId)}`);
    const deployment = response.deployments.find((item) => item.id === deploymentId);
    if (!deployment) throw new Error(`deployment disappeared from history: ${deploymentId}`);
    if (!activePhases.has(deployment.phase)) return deployment;
    await new Promise((resolveWait) => setTimeout(resolveWait, options.pollSeconds * 1000));
  }
  throw new Error(`deployment did not reach a terminal phase in ${options.timeoutSeconds}s: ${deploymentId}`);
}

async function api(path, input = {}) {
  const response = await fetch(`${options.controlPlaneUrl.replace(/\/$/, "")}${path}`, {
    method: input.method || "GET",
    headers: {
      "x-admin-token": adminToken,
      ...(input.body ? { "content-type": "application/json" } : {})
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {})
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${input.method || "GET"} ${path} failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function stageArtifact(releaseDir, sha256, contents) {
  const directory = resolve(releaseDir);
  const destination = resolve(directory, sha256);
  if (dirname(destination) !== directory || basename(destination) !== sha256) {
    throw new Error("invalid artifact destination");
  }
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const temporary = `${destination}.${process.pid}.partial`;
  await rm(temporary, { force: true });
  await copyFile(binary, temporary);
  // The rollout command runs as root because the nftables parser self-test
  // requires CAP_NET_ADMIN. Keep the immutable artifact executable/readable by
  // the unprivileged API process after root atomically stages it.
  await chmod(temporary, 0o755);
  await rename(temporary, destination);
  const staged = await readFile(destination);
  if (createHash("sha256").update(staged).digest("hex") !== sha256 || !staged.equals(contents)) {
    throw new Error("staged gate-agent artifact failed its SHA-256 verification");
  }
}

function orderCanary(gates, canary) {
  const selected = canary || [...gates].sort()[0];
  if (!gates.includes(selected)) throw new Error(`canary gate is not selected: ${selected}`);
  return [selected, ...gates.filter((gate) => gate !== selected)];
}

function parseArgs(argv) {
  const parsed = {
    gates: [],
    execute: false,
    releaseDir: "/var/lib/hyperspace/gate-agent-releases",
    pollSeconds: 5,
    timeoutSeconds: 900
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--binary": parsed.binary = argv[++index]; break;
      case "--control-plane-url": parsed.controlPlaneUrl = argv[++index]; break;
      case "--admin-token-file": parsed.adminTokenFile = argv[++index]; break;
      case "--release-dir": parsed.releaseDir = argv[++index]; break;
      case "--inventory": parsed.inventory = argv[++index]; break;
      case "--wave": parsed.wave = argv[++index]; break;
      case "--gate": parsed.gates.push(argv[++index]); break;
      case "--canary-gate": parsed.canaryGate = argv[++index]; break;
      case "--poll-seconds": parsed.pollSeconds = Number(argv[++index]); break;
      case "--timeout-seconds": parsed.timeoutSeconds = Number(argv[++index]); break;
      case "--execute": parsed.execute = true; break;
      case "-h":
      case "--help": usage(); process.exit(0);
      default: throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!Number.isFinite(parsed.pollSeconds) || parsed.pollSeconds <= 0) throw new Error("--poll-seconds must be positive");
  if (!Number.isFinite(parsed.timeoutSeconds) || parsed.timeoutSeconds <= 0) throw new Error("--timeout-seconds must be positive");
  return parsed;
}

function usage() {
  process.stderr.write(`usage: scripts/gates/control-plane-rollout.mjs --binary PATH --control-plane-url URL --admin-token-file PATH (--gate NAME [--gate NAME ...] | --inventory PATH --wave WAVE) [--canary-gate NAME] [--release-dir PATH] [--execute]\n`);
}
