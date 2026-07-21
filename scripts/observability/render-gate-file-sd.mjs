#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function renderGateTargets(payload, options) {
  if (!payload || !Array.isArray(payload.gates)) {
    throw new Error("gate catalog response must contain a gates array");
  }
  const cluster = requireText(options.cluster, "cluster");
  const port = Number(options.port ?? 9100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("node exporter port must be an integer from 1 to 65535");
  }

  return payload.gates
    .filter((gate) => gate?.desiredState === "Enabled")
    .map((gate) => {
      const gateName = requireText(gate.name, "gate.name");
      const publicIpv4 = requireText(gate.publicIpv4, `${gateName}.publicIpv4`);
      return {
        targets: [`${publicIpv4}:${port}`],
        labels: {
          cluster,
          role: "gate",
          gate: gateName,
          probe_host: probeHost(gate.probeUrl, publicIpv4),
          public_ipv4: publicIpv4,
          desired_state: "Enabled"
        }
      };
    })
    .sort((left, right) => left.labels.gate.localeCompare(right.labels.gate));
}

export async function writeTargetsAtomically(outputPath, targets) {
  const destination = resolve(outputPath);
  const temporary = `${destination}.tmp`;
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(targets, null, 2)}\n`, { mode: 0o644 });
  await rename(temporary, destination);
}

async function loadPayload(options) {
  if (options.input) {
    return JSON.parse(await readFile(options.input, "utf8"));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetch(requireText(options.url, "url"), {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`gate catalog returned HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function probeHost(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }
  try {
    return new URL(value).hostname || fallback;
  } catch {
    return fallback;
  }
}

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function parseArgs(argv) {
  const options = { port: 9100, timeoutMs: 10_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--url": options.url = argv[++index]; break;
      case "--input": options.input = argv[++index]; break;
      case "--cluster": options.cluster = argv[++index]; break;
      case "--output": options.output = argv[++index]; break;
      case "--port": options.port = Number(argv[++index]); break;
      case "--timeout-ms": options.timeoutMs = Number(argv[++index]); break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if ((!options.url && !options.input) || !options.cluster || !options.output) {
    throw new Error("usage: render-gate-file-sd.mjs (--url URL | --input FILE) --cluster NAME --output FILE [--port 9100]");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = await loadPayload(options);
  const targets = renderGateTargets(payload, options);
  if (targets.length === 0) {
    throw new Error("refusing to replace discovery file with an empty enabled gate catalog");
  }
  await writeTargetsAtomically(options.output, targets);
  process.stdout.write(`rendered ${targets.length} enabled gate targets to ${resolve(options.output)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  );
}
