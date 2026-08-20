#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const apiBase = stripTrailingSlash(requiredEnv("HS_API_BASE"));
const sshKey = requiredEnv("HS_TESTNODE_SSH_KEY");
const sourceHost = requiredEnv("HS_SOURCE_HOST");
const sourceIp = requiredEnv("HS_SOURCE_IP");
const targetIp = requiredEnv("HS_TARGET_IP");
const api = makeApiClient(apiBase);
const token = await resolveToken();
const outputDir = process.env.HS_TEST_OUTPUT_DIR || "m3-results/live-gate-cycle";
const probePath = process.env.HS_TEST_PROBE_PATH || "/opt/hyperspace-testnodes/one_way_probe.py";
const probePort = Number(process.env.HS_TEST_PROBE_PORT || "19191");
const probeCount = Number(process.env.HS_GATE_CYCLE_PROBE_COUNT || "5");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const sessionsToCleanup = new Set();
const result = {
  runId,
  apiBase,
  source: { host: sourceHost, publicIp: sourceIp },
  target: { publicIp: targetIp },
  routes: []
};

await mkdir(outputDir, { recursive: true });

try {
  await assertPlainProbe();
  const gateResponse = await api("/v1/public/gates");
  const gates = (Array.isArray(gateResponse?.gates) ? gateResponse.gates : [])
    .filter((gate) => gate.ready === true && gate.schedulable === true)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  assert(gates.length >= 2, "expected at least two ready and schedulable gates");
  result.gateCount = gates.length;
  const startAt = Number(process.env.HS_GATE_CYCLE_START || "1");
  const endAt = Number(process.env.HS_GATE_CYCLE_END || String(gates.length));
  const selectedIndices = new Set(
    String(process.env.HS_GATE_CYCLE_INDICES || "")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= gates.length)
  );
  const selectedPairs = new Set(
    String(process.env.HS_GATE_CYCLE_PAIRS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  assert(Number.isInteger(startAt) && startAt >= 1, "HS_GATE_CYCLE_START must be a positive integer");
  assert(Number.isInteger(endAt) && endAt >= startAt && endAt <= gates.length, "HS_GATE_CYCLE_END is outside the gate list");
  result.range = { startAt, endAt };
  if (selectedIndices.size > 0) result.selectedIndices = [...selectedIndices].sort((left, right) => left - right);
  if (selectedPairs.size > 0) result.selectedPairs = [...selectedPairs].sort();

  for (let index = 0; index < gates.length; index += 1) {
    const ingress = gates[index];
    const egress = gates[(index + 1) % gates.length];
    const pairName = `${ingress.name}>${egress.name}`;
    if (selectedPairs.size > 0 && !selectedPairs.has(pairName)) continue;
    if (selectedPairs.size === 0 && (index + 1 < startAt || index + 1 > endAt)) continue;
    if (selectedPairs.size === 0 && selectedIndices.size > 0 && !selectedIndices.has(index + 1)) continue;
    const route = {
      index: index + 1,
      ingressGateName: ingress.name,
      egressGateName: egress.name,
      status: "running"
    };
    result.routes.push(route);
    process.stdout.write(`[${index + 1}/${gates.length}] ${ingress.name} -> ${egress.name} ... `);
    let sessionId = "";
    try {
      const created = await createPaidSession(ingress.name, egress.name, index + 1);
      sessionId = String(created.response.session.id);
      sessionsToCleanup.add(sessionId);
      route.sessionId = sessionId;
      route.paymentFinalizationRetries = created.paymentFinalizationRetries;
      await waitForSession(sessionId, "active", 180_000);
      const configText = await downloadRawConfig(sessionId);
      const probe = await runWireGuardProbe(configText, `hsg${String(index + 1).padStart(2, "0")}`);
      assert(probe?.received === probeCount && probe?.lost === 0, `probe lost traffic: ${JSON.stringify(probe)}`);
      route.probe = compactProbe(probe);
      route.status = "passed";
      process.stdout.write(`passed (${route.probe.rttP50Ms} ms)\n`);
    } catch (error) {
      route.status = "failed";
      route.error = error instanceof Error ? error.message : String(error);
      process.stdout.write(`failed: ${route.error}\n`);
    } finally {
      if (sessionId) {
        try {
          await revokeAndDelete(sessionId);
          sessionsToCleanup.delete(sessionId);
          route.cleanedUp = true;
        } catch (error) {
          route.cleanupError = error instanceof Error ? error.message : String(error);
        }
      }
    }
  }

  const failures = result.routes.filter((route) => route.status !== "passed" || route.cleanedUp !== true);
  if (selectedPairs.size > 0) assert(result.routes.length === selectedPairs.size, "one or more requested gate pairs were unavailable");
  result.ingressGatesCovered = new Set(result.routes.filter((route) => route.status === "passed").map((route) => route.ingressGateName)).size;
  result.egressGatesCovered = new Set(result.routes.filter((route) => route.status === "passed").map((route) => route.egressGateName)).size;
  result.status = failures.length === 0 ? "passed" : "failed";
  result.summary = {
    total: result.routes.length,
    passed: result.routes.filter((route) => route.status === "passed").length,
    failed: failures.length
  };
  assert(failures.length === 0, `${failures.length} gate-cycle route(s) failed`);
} catch (error) {
  result.status = "failed";
  result.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  for (const sessionId of [...sessionsToCleanup]) {
    await revokeAndDelete(sessionId).catch(() => undefined);
  }
  const outputPath = path.join(outputDir, `live-gate-cycle-${runId}.json`);
  await writeFile(outputPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ outputPath, status: result.status, summary: result.summary || null }, null, 2));
}

async function resolveToken() {
  const configured = process.env.HS_GATE_CYCLE_TOKEN?.trim();
  if (configured) return configured;
  const response = await api("/v1/public/auth/login", {
    method: "POST",
    body: {
      email: requiredEnv("HS_GATE_CYCLE_EMAIL"),
      password: requiredEnv("HS_GATE_CYCLE_PASSWORD")
    }
  });
  return String(response.accessToken);
}

async function assertPlainProbe() {
  const completed = await ssh(`${probePath} client ${shellQuote(targetIp)} --port ${probePort} --count 5 --interval 0.05 --timeout 1`);
  const probe = parseProbe(completed.stdout);
  assert(completed.code === 0 && probe?.received === 5, "plain UDP baseline probe failed");
  result.plainBaseline = compactProbe(probe);
}

async function createPaidSession(ingressGateName, egressGateName, index) {
  const body = {
    mode: "IpToIp",
    label: `m3-gate-cycle-${String(index).padStart(2, "0")}`,
    paymentRequestId: randomUUID(),
    sourceIp,
    targetIp,
    ingressGateName,
    egressGateName
  };
  let paymentFinalizationRetries = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await api("/v1/public/sessions", { method: "POST", token, body });
      return { response, paymentFinalizationRetries };
    } catch (error) {
      if (error?.code !== "config_payment_in_progress" || attempt === 29) throw error;
      paymentFinalizationRetries += 1;
      await wait(1_000);
    }
  }
  throw new Error("session payment did not finalize");
}

async function downloadRawConfig(sessionId) {
  const response = await api(`/v1/public/sessions/${sessionId}/artifacts/client-config/download-token`, {
    method: "POST",
    token
  });
  const downloadUrl = response.downloadConfigUrl;
  assert(typeof downloadUrl === "string", "downloadConfigUrl is missing");
  const fetched = await fetch(resolveApiUrl(apiBase, downloadUrl), {
    headers: { Authorization: `Bearer ${token}` }
  });
  const configText = await fetched.text();
  assert(fetched.ok, `config download failed: ${fetched.status}`);
  assert(configText.includes("[Interface]") && configText.includes("[Peer]"), "invalid WireGuard config");
  return configText;
}

async function runWireGuardProbe(configText, interfaceName) {
  const configPath = `/tmp/${interfaceName}.conf`;
  const completed = await ssh(`
set -euo pipefail
umask 077
cat > ${shellQuote(configPath)}
cleanup() { wg-quick down ${shellQuote(configPath)} >/dev/null 2>&1 || true; rm -f ${shellQuote(configPath)}; }
trap cleanup EXIT
wg-quick down ${shellQuote(configPath)} >/dev/null 2>&1 || true
wg-quick up ${shellQuote(configPath)} >/dev/null
${probePath} client ${shellQuote(targetIp)} --port ${probePort} --count 1 --interval 0.05 --timeout 2 >/dev/null 2>&1 || true
sleep 1
${probePath} client ${shellQuote(targetIp)} --port ${probePort} --count ${probeCount} --interval 0.05 --timeout 1
`, { input: configText, timeoutMs: 45_000 });
  assert(completed.code === 0, `WireGuard probe failed: ${completed.stderr || completed.stdout}`);
  return parseProbe(completed.stdout);
}

async function revokeAndDelete(sessionId) {
  await api(`/v1/public/sessions/${sessionId}/revoke`, { method: "POST", token });
  await waitForSession(sessionId, "revoked", 180_000);
  await api(`/v1/public/sessions/${sessionId}`, { method: "DELETE", token });
}

async function waitForSession(sessionId, phase, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await api(`/v1/public/sessions/${sessionId}`, { token });
    last = response.session;
    if (last.phase === phase) return last;
    if (last.phase === "failed") throw new Error(`session failed: ${JSON.stringify(last.lastError || {})}`);
    await wait(1_500);
  }
  throw new Error(`timed out waiting for ${sessionId} to reach ${phase}; last=${JSON.stringify(last)}`);
}

function makeApiClient(base) {
  return async function request(apiPath, options = {}) {
    const response = await fetch(resolveApiUrl(base, apiPath), {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(`${options.method || "GET"} ${apiPath} failed: ${response.status} ${text}`);
      error.status = response.status;
      error.code = payload?.error || "http_error";
      throw error;
    }
    return payload;
  };
}

async function ssh(command, { input = "", timeoutMs = 30_000 } = {}) {
  return await new Promise((resolve) => {
    const child = spawn("ssh", [
      "-i", sshKey,
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=10",
      `root@${sourceHost}`,
      command
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr || String(error) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: typeof code === "number" ? code : 1, stdout, stderr: signal ? `${stderr}\nterminated by ${signal}` : stderr });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function parseProbe(stdout) {
  for (const line of stdout.trim().split("\n").reverse()) {
    if (!line.startsWith("{")) continue;
    try { return JSON.parse(line); } catch { /* keep looking */ }
  }
  return null;
}

function compactProbe(probe) {
  return {
    sent: probe.sent,
    received: probe.received,
    lost: probe.lost,
    lossPercent: probe.loss_percent,
    rttP50Ms: probe.rtt_ms?.p50 ?? null
  };
}

function resolveApiUrl(base, value) {
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return `${base}${value.startsWith("/") ? "" : "/"}${value}`;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
