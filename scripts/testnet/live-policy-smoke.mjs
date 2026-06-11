#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const apiBase = stripTrailingSlash(requiredEnv("HS_API_BASE"));
const outputDir = process.env.HS_TEST_OUTPUT_DIR || "m1-results/live-testnet";
const sshKey = requiredEnv("HS_TESTNODE_SSH_KEY");
const probePath = process.env.HS_TEST_PROBE_PATH || "/opt/hyperspace-testnodes/one_way_probe.py";
const probePort = Number(process.env.HS_TEST_PROBE_PORT || "19191");
const ingressGateName = requiredEnv("HS_TEST_INGRESS");
const egressGateName = requiredEnv("HS_TEST_EGRESS");
const allowedSource = {
  key: process.env.HS_ALLOWED_SOURCE_KEY || "allowed-source",
  host: requiredEnv("HS_ALLOWED_SOURCE_HOST"),
  publicIp: requiredEnv("HS_ALLOWED_SOURCE_IP")
};
const deniedSource = {
  key: process.env.HS_DENIED_SOURCE_KEY || "denied-source",
  host: requiredEnv("HS_DENIED_SOURCE_HOST"),
  publicIp: requiredEnv("HS_DENIED_SOURCE_IP")
};
const target = {
  key: process.env.HS_TARGET_KEY || "target",
  host: requiredEnv("HS_TARGET_HOST"),
  publicIp: requiredEnv("HS_TARGET_IP")
};
const nonTarget = {
  key: process.env.HS_NON_TARGET_KEY || "non-target",
  host: requiredEnv("HS_NON_TARGET_HOST"),
  publicIp: requiredEnv("HS_NON_TARGET_IP")
};

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const email = process.env.HS_POLICY_EMAIL || `policy-smoke-${Date.now()}@example.com`;
const password = process.env.HS_POLICY_PASSWORD || `Policy-smoke-${Date.now()}-strong-password`;
const api = makeApiClient(apiBase);
const result = {
  runId,
  apiBase,
  email,
  ingressGateName,
  egressGateName,
  allowedSource,
  deniedSource,
  target,
  nonTarget,
  steps: [],
  checks: []
};

await mkdir(outputDir, { recursive: true });

let token = "";
const sessionsToCleanup = [];

try {
  await assertProbeServersReachable();
  token = await register();

  const restricted = await createSession({
    label: `policy-restricted-${runId}`,
    sourceIp: allowedSource.publicIp,
    targetIp: target.publicIp
  });
  sessionsToCleanup.push(restricted.id);
  const restrictedConfig = await downloadRawConfig(restricted.id);

  const targetProbe = await runWgProbe({
    node: allowedSource,
    configText: restrictedConfig,
    interfaceName: "hspol0",
    probeIp: target.publicIp
  });
  assert(targetProbe.ok, `allowed source could not reach target: ${targetProbe.stderr || targetProbe.stdout}`);
  assert(targetProbe.probe?.received > 0, "allowed target probe did not receive packets");
  result.checks.push({
    id: "WG-001",
    status: "passed",
    detail: `${allowedSource.key} reached ${target.key} through ${ingressGateName}->${egressGateName}`,
    probe: compactProbe(targetProbe.probe)
  });

  const configWithNonTargetRoute = widenAllowedIps(restrictedConfig, nonTarget.publicIp);
  const nonTargetProbe = await runWgProbe({
    node: allowedSource,
    configText: configWithNonTargetRoute,
    interfaceName: "hspol1",
    probeIp: nonTarget.publicIp,
    expectSuccess: false
  });
  assert(!nonTargetProbe.ok || nonTargetProbe.probe?.received === 0, "non-target probe unexpectedly succeeded");
  result.checks.push({
    id: "WG-002",
    status: "passed",
    detail: `${allowedSource.key} could not reach non-target ${nonTarget.key} after client-side AllowedIPs widening`,
    probe: compactProbe(nonTargetProbe.probe)
  });

  const wrongSourceProbe = await runWgProbe({
    node: deniedSource,
    configText: restrictedConfig,
    interfaceName: "hspol2",
    probeIp: target.publicIp,
    expectSuccess: false
  });
  assert(!wrongSourceProbe.ok || wrongSourceProbe.probe?.received === 0, "source-restricted config worked from denied source");
  result.checks.push({
    id: "WG-004",
    status: "passed",
    detail: `${deniedSource.key} could not use a config restricted to ${allowedSource.publicIp}`,
    probe: compactProbe(wrongSourceProbe.probe)
  });

  const keyPair = await createRemoteWireGuardKeyPair(allowedSource);
  const custom = await createSession({
    label: `policy-custom-key-${runId}`,
    sourceIp: allowedSource.publicIp,
    targetIp: target.publicIp,
    clientPublicKey: keyPair.publicKey
  });
  sessionsToCleanup.push(custom.id);
  const customPlaceholderConfig = await downloadRawConfig(custom.id);
  assert(
    customPlaceholderConfig.includes("<replace-with-matching-client-private-key>"),
    "custom-key config did not contain the expected private-key placeholder"
  );

  const customMatchingConfig = customPlaceholderConfig.replace(
    "<replace-with-matching-client-private-key>",
    keyPair.privateKey
  );
  const customMatchProbe = await runWgProbe({
    node: allowedSource,
    configText: customMatchingConfig,
    interfaceName: "hspol3",
    probeIp: target.publicIp
  });
  assert(customMatchProbe.ok && customMatchProbe.probe?.received > 0, "custom public key did not work with matching private key");
  result.checks.push({
    id: "WG-005A",
    status: "passed",
    detail: "custom client public key worked with its matching private key",
    probe: compactProbe(customMatchProbe.probe)
  });

  const wrongPrivateKey = await generateRemotePrivateKey(allowedSource);
  const customWrongConfig = customPlaceholderConfig.replace(
    "<replace-with-matching-client-private-key>",
    wrongPrivateKey
  );
  const customWrongProbe = await runWgProbe({
    node: allowedSource,
    configText: customWrongConfig,
    interfaceName: "hspol4",
    probeIp: target.publicIp,
    expectSuccess: false
  });
  assert(!customWrongProbe.ok || customWrongProbe.probe?.received === 0, "custom public key worked with a wrong private key");
  result.checks.push({
    id: "WG-005B",
    status: "passed",
    detail: "custom client public key did not work with a non-matching private key",
    probe: compactProbe(customWrongProbe.probe)
  });

  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  for (const sessionId of sessionsToCleanup.reverse()) {
    await revokeAndDelete(sessionId).catch((error) => {
      result.checks.push({
        id: "cleanup",
        status: "failed",
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
  await writeFile(path.join(outputDir, `live-policy-smoke-${runId}.json`), JSON.stringify(result, null, 2));
}

console.log(JSON.stringify(result, null, 2));

async function assertProbeServersReachable() {
  for (const node of [target, nonTarget]) {
    const probe = await runPlainProbe(allowedSource, node.publicIp);
    assert(probe.ok && probe.probe?.received > 0, `probe server on ${node.key} is not reachable from ${allowedSource.key}`);
  }
  result.steps.push("probe_servers_reachable");
}

async function register() {
  const response = await api("/v1/public/auth/register", {
    method: "POST",
    body: {
      email,
      password,
      displayName: "Live Policy Smoke"
    }
  });
  result.steps.push("registered");
  return String(response.accessToken);
}

async function createSession({ label, sourceIp, targetIp, clientPublicKey }) {
  const response = await api("/v1/public/sessions", {
    method: "POST",
    token,
    body: {
      mode: "IpToIp",
      label,
      sourceIp,
      targetIp,
      ingressGateName,
      egressGateName,
      ...(clientPublicKey ? { clientPublicKey } : {})
    }
  });
  const sessionId = String(response.session.id);
  const active = await waitForSession(sessionId, "active", 120000);
  result.steps.push(`session_active:${label}`);
  return active;
}

async function downloadRawConfig(sessionId) {
  const tokenResponse = await api(`/v1/public/sessions/${sessionId}/artifacts/client-config/download-token`, {
    method: "POST",
    token
  });
  const configText = await fetchText(resolveApiUrl(apiBase, tokenResponse.downloadConfigUrl), token);
  assert(configText.includes("[Interface]") && configText.includes("[Peer]"), "downloadConfigUrl did not return a WireGuard config");
  assert(!configText.trim().startsWith("{"), "downloadConfigUrl returned JSON instead of raw .conf");
  return configText;
}

async function revokeAndDelete(sessionId) {
  await api(`/v1/public/sessions/${sessionId}/revoke`, { method: "POST", token });
  await waitForSession(sessionId, "revoked", 120000);
  await api(`/v1/public/sessions/${sessionId}`, { method: "DELETE", token });
}

async function waitForSession(sessionId, phase, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await api(`/v1/public/sessions/${sessionId}`, { token });
    last = response.session;
    if (last.phase === phase) {
      return last;
    }
    if (last.phase === "failed") {
      throw new Error(`session ${sessionId} failed: ${JSON.stringify(last.lastError || {})}`);
    }
    await wait(1500);
  }
  throw new Error(`timed out waiting for ${sessionId} to reach ${phase}; last=${JSON.stringify(last)}`);
}

async function runPlainProbe(sourceNode, probeIp) {
  const command = `${probePath} client ${shellQuote(probeIp)} --port ${probePort} --count 5 --interval 0.05 --timeout 1.0`;
  const completed = await ssh(sourceNode.host, command, { timeoutMs: 30000 });
  return parseProbeResult(completed);
}

async function runWgProbe({ node, configText, interfaceName, probeIp, expectSuccess = true }) {
  const configPath = `/tmp/${interfaceName}.conf`;
  const command = `
set +e
umask 077
cat > ${shellQuote(configPath)}
wg-quick down ${shellQuote(configPath)} >/dev/null 2>&1
wg-quick up ${shellQuote(configPath)} >/tmp/${interfaceName}.up.log 2>&1
up_rc=$?
if [ "$up_rc" -ne 0 ]; then
  cat /tmp/${interfaceName}.up.log >&2
  rm -f ${shellQuote(configPath)}
  exit "$up_rc"
fi
sleep 2
ip route get ${shellQuote(probeIp)} || true
${probePath} client ${shellQuote(probeIp)} --port ${probePort} --count 10 --interval 0.05 --timeout 1.0
probe_rc=$?
wg-quick down ${shellQuote(configPath)} >/dev/null 2>&1
rm -f ${shellQuote(configPath)}
exit "$probe_rc"
`;
  const completed = await ssh(node.host, command, { input: configText, timeoutMs: 60000 });
  const parsed = parseProbeResult(completed);
  if (expectSuccess && !parsed.ok) {
    throw new Error(`WireGuard probe failed on ${node.key}: rc=${completed.code} stdout=${completed.stdout} stderr=${completed.stderr}`);
  }
  return parsed;
}

async function createRemoteWireGuardKeyPair(node) {
  const completed = await ssh(
    node.host,
    "set -euo pipefail; private=$(wg genkey); public=$(printf '%s' \"$private\" | wg pubkey); printf '%s\\n%s\\n' \"$private\" \"$public\"",
    { timeoutMs: 30000 }
  );
  if (completed.code !== 0) {
    throw new Error(`failed to generate remote WireGuard key pair: ${completed.stderr}`);
  }
  const [privateKey, publicKey] = completed.stdout.trim().split("\n");
  assert(privateKey && publicKey, "remote WireGuard key generation returned an unexpected payload");
  return { privateKey, publicKey };
}

async function generateRemotePrivateKey(node) {
  const completed = await ssh(node.host, "wg genkey", { timeoutMs: 30000 });
  if (completed.code !== 0) {
    throw new Error(`failed to generate remote WireGuard private key: ${completed.stderr}`);
  }
  return completed.stdout.trim();
}

async function ssh(host, command, { input = "", timeoutMs = 120000 } = {}) {
  const args = [
    "-i",
    sshKey,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
    `root@${host}`,
    command
  ];
  return await new Promise((resolve) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr || String(error) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: typeof code === "number" ? code : 1,
        stdout,
        stderr: signal ? `${stderr}\nterminated by ${signal}` : stderr
      });
    });
    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

function parseProbeResult(completed) {
  const lines = completed.stdout.trim().split("\n").filter(Boolean);
  let probe = null;
  for (const line of [...lines].reverse()) {
    if (!line.trim().startsWith("{")) {
      continue;
    }
    try {
      probe = JSON.parse(line);
      break;
    } catch {
      continue;
    }
  }
  return {
    ok: completed.code === 0,
    code: completed.code,
    stdout: completed.stdout,
    stderr: completed.stderr,
    probe
  };
}

function widenAllowedIps(configText, ip) {
  return configText.replace(/^AllowedIPs\s*=\s*(.+)$/m, (_match, current) => {
    const values = String(current).split(",").map((value) => value.trim()).filter(Boolean);
    const widened = values.includes(`${ip}/32`) ? values : [...values, `${ip}/32`];
    return `AllowedIPs = ${widened.join(", ")}`;
  });
}

function compactProbe(probe) {
  if (!probe) {
    return null;
  }
  return {
    target: probe.target,
    sent: probe.sent,
    received: probe.received,
    lost: probe.lost,
    lossPercent: probe.loss_percent,
    rttP50Ms: probe.rtt_ms?.p50 ?? null,
    forwardP50Ms: probe.forward_one_way_ms?.p50 ?? null,
    reverseP50Ms: probe.reverse_one_way_ms?.p50 ?? null
  };
}

function makeApiClient(base) {
  return async function apiRequest(apiPath, options = {}) {
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
      throw new Error(`${options.method || "GET"} ${apiPath} failed: ${response.status} ${text}`);
    }
    return payload;
  };
}

async function fetchText(url, bearerToken) {
  const response = await fetch(url, {
    headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${text}`);
  }
  return text;
}

function resolveApiUrl(base, apiPath) {
  if (apiPath.startsWith("http://") || apiPath.startsWith("https://")) {
    return apiPath;
  }
  return `${base}${apiPath.startsWith("/") ? "" : "/"}${apiPath}`;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
