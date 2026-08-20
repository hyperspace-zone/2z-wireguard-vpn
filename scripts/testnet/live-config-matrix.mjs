#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createResendAuthHelper, uniqueResendAddress } from "./resend-auth-helper.mjs";

const apiBase = stripTrailingSlash(requiredEnv("HS_API_BASE"));
const outputDir = process.env.HS_TEST_OUTPUT_DIR || "m2-results/live-config-matrix";
const sshKey = requiredEnv("HS_TESTNODE_SSH_KEY");
const probePath = process.env.HS_TEST_PROBE_PATH || "/opt/hyperspace-testnodes/one_way_probe.py";
const probePort = Number(process.env.HS_TEST_PROBE_PORT || "19191");
const ingressGateName = requiredEnv("HS_TEST_INGRESS");
const egressGateName = requiredEnv("HS_TEST_EGRESS");
const allowedSource = nodeFromEnv("HS_ALLOWED_SOURCE", "allowed-source");
const deniedSource = nodeFromEnv("HS_DENIED_SOURCE", "denied-source");
const target = nodeFromEnv("HS_TARGET", "target");
const nonTarget = nodeFromEnv("HS_NON_TARGET", "non-target");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const email = process.env.HS_CONFIG_MATRIX_EMAIL || uniqueResendAddress("config-matrix");
const password = process.env.HS_CONFIG_MATRIX_PASSWORD || `Config-matrix-${Date.now()}-strong-password`;
const existingAccount = process.env.HS_CONFIG_MATRIX_EXISTING_ACCOUNT === "true";
const existingAccessToken = process.env.HS_CONFIG_MATRIX_TOKEN?.trim() || "";
const api = makeApiClient(apiBase);
const resendAuth = createResendAuthHelper({ api });
const sessionsToCleanup = [];
const result = {
  runId,
  apiBase,
  email,
  ingressGateName,
  egressGateName,
  nodes: { allowedSource, deniedSource, target, nonTarget },
  scenarios: [],
  checks: []
};

await mkdir(outputDir, { recursive: true });

let token = "";
try {
  await assertProbeServersReachable();
  token = await register();
  const keyPair = await createRemoteWireGuardKeyPair(allowedSource);
  const wrongPrivateKey = await generateRemotePrivateKey(allowedSource);

  const scenarios = buildScenarios(keyPair, wrongPrivateKey);
  let index = 0;
  for (const scenario of scenarios) {
    index += 1;
    await runScenario({ scenario, index });
  }

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
  const outputPath = path.join(outputDir, `live-config-matrix-${runId}.json`);
  await writeFile(outputPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ outputPath, status: result.status, checks: summarizeChecks(result.checks) }, null, 2));
}

function buildScenarios(keyPair, wrongPrivateKey) {
  const scenarios = [];
  for (const sourceRestricted of [true, false]) {
    for (const destinationRestricted of [true, false]) {
      for (const providedPublicKey of [false, true]) {
        scenarios.push({
          id: [
            sourceRestricted ? "source-restricted" : "source-unrestricted",
            destinationRestricted ? "destination-restricted" : "destination-unrestricted",
            providedPublicKey ? "provided-public-key" : "generated-key"
          ].join("__"),
          sourceRestricted,
          destinationRestricted,
          providedPublicKey,
          matchingPrivateKey: providedPublicKey ? keyPair.privateKey : null,
          providedPublicKeyValue: providedPublicKey ? keyPair.publicKey : null,
          wrongPrivateKey: providedPublicKey ? wrongPrivateKey : null
        });
      }
    }
  }
  return scenarios;
}

async function runScenario({ scenario, index }) {
  let session = null;
  let scenarioResult = null;
  try {
    session = await createSession(scenario);
    sessionsToCleanup.push(session.id);
    const rawConfig = await downloadRawConfig(session.id);
    const configText = materializeConfig(rawConfig, scenario.matchingPrivateKey);
    const interfaceBase = `hsmat${index}`;
    scenarioResult = {
      id: scenario.id,
      sessionId: session.id,
      mode: scenario.destinationRestricted ? "IpToIp" : "FullTunnel",
      sourceRestricted: scenario.sourceRestricted,
      destinationRestricted: scenario.destinationRestricted,
      providedPublicKey: scenario.providedPublicKey,
      checks: []
    };
    result.scenarios.push(scenarioResult);

    if (scenario.providedPublicKey) {
      assert(rawConfig.includes("<replace-with-matching-client-private-key>"), `${scenario.id}: custom-key config did not contain private-key placeholder`);
    } else {
      assert(!rawConfig.includes("<replace-with-matching-client-private-key>"), `${scenario.id}: generated-key config unexpectedly contained private-key placeholder`);
    }

    const targetConfig = routeConfigForProbe(configText, target.publicIp);
    const targetProbe = await runWgProbe({
      node: allowedSource,
      configText: targetConfig,
      interfaceName: `${interfaceBase}a`,
      probeIp: target.publicIp
    });
    recordCheck(scenarioResult, {
      id: `${scenario.id}:allowed-source-target`,
      expected: "success",
      actual: targetProbe,
      detail: `${allowedSource.key} reached target ${target.key}`
    });

    const nonTargetConfig = routeConfigForProbe(configText, nonTarget.publicIp);
    const nonTargetProbe = await runWgProbe({
      node: allowedSource,
      configText: nonTargetConfig,
      interfaceName: `${interfaceBase}b`,
      probeIp: nonTarget.publicIp,
      expectSuccess: !scenario.destinationRestricted
    });
    if (scenario.destinationRestricted) {
      assertProbeFailed(nonTargetProbe, `${scenario.id}: destination-restricted config reached non-target`);
      recordCheck(scenarioResult, {
        id: `${scenario.id}:non-target-denied`,
        expected: "failure",
        actual: nonTargetProbe,
        detail: `${allowedSource.key} could not reach non-target ${nonTarget.key}`
      });
    } else {
      recordCheck(scenarioResult, {
        id: `${scenario.id}:non-target-allowed`,
        expected: "success",
        actual: nonTargetProbe,
        detail: `${allowedSource.key} reached non-target ${nonTarget.key}`
      });
    }

    const deniedSourceProbe = await runWgProbe({
      node: deniedSource,
      configText: targetConfig,
      interfaceName: `${interfaceBase}c`,
      probeIp: target.publicIp,
      expectSuccess: !scenario.sourceRestricted
    });
    if (scenario.sourceRestricted) {
      assertProbeFailed(deniedSourceProbe, `${scenario.id}: source-restricted config worked from denied source`);
      recordCheck(scenarioResult, {
        id: `${scenario.id}:denied-source-blocked`,
        expected: "failure",
        actual: deniedSourceProbe,
        detail: `${deniedSource.key} could not use config restricted to ${allowedSource.publicIp}`
      });
    } else {
      recordCheck(scenarioResult, {
        id: `${scenario.id}:source-unrestricted-second-source`,
        expected: "success",
        actual: deniedSourceProbe,
        detail: `${deniedSource.key} used source-unrestricted config`
      });
    }

    if (scenario.providedPublicKey) {
      const wrongConfig = materializeConfig(rawConfig, scenario.wrongPrivateKey);
      const wrongKeyProbe = await runWgProbe({
        node: allowedSource,
        configText: routeConfigForProbe(wrongConfig, target.publicIp),
        interfaceName: `${interfaceBase}d`,
        probeIp: target.publicIp,
        expectSuccess: false
      });
      assertProbeFailed(wrongKeyProbe, `${scenario.id}: provided public key worked with wrong private key`);
      recordCheck(scenarioResult, {
        id: `${scenario.id}:wrong-private-key-blocked`,
        expected: "failure",
        actual: wrongKeyProbe,
        detail: "provided client public key only worked with matching private key"
      });
    }
  } finally {
    if (session) {
      await revokeAndDelete(session.id);
      const cleanupIndex = sessionsToCleanup.indexOf(session.id);
      if (cleanupIndex !== -1) {
        sessionsToCleanup.splice(cleanupIndex, 1);
      }
      if (scenarioResult) {
        scenarioResult.cleanedUp = true;
      }
    }
  }
}

async function assertProbeServersReachable() {
  for (const source of [allowedSource, deniedSource]) {
    for (const node of [target, nonTarget]) {
      const probe = await runPlainProbe(source, node.publicIp);
      assert(probe.ok && probe.probe?.received > 0, `probe server on ${node.key} is not reachable from ${source.key}`);
      result.checks.push({
        id: `baseline:${source.key}->${node.key}`,
        status: "passed",
        probe: compactProbe(probe.probe)
      });
    }
  }
}

async function register() {
  if (existingAccessToken) {
    return existingAccessToken;
  }
  if (existingAccount) {
    const response = await api("/v1/public/auth/login", {
      method: "POST",
      body: { email, password }
    });
    return String(response.accessToken);
  }
  const response = await resendAuth.registerPassword({
    email,
    password,
    displayName: "Live Config Matrix"
  });
  return String(response.accessToken);
}

async function createSession(scenario) {
  const body = {
    mode: scenario.destinationRestricted ? "IpToIp" : "FullTunnel",
    label: scenario.id,
    paymentRequestId: randomUUID(),
    ...(scenario.sourceRestricted ? { sourceIp: allowedSource.publicIp } : {}),
    ...(scenario.destinationRestricted ? { targetIp: target.publicIp } : {}),
    ingressGateName,
    egressGateName,
    ...(scenario.providedPublicKey ? { clientPublicKey: scenario.providedPublicKeyValue } : {})
  };
  let response = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      response = await api("/v1/public/sessions", { method: "POST", token, body });
      break;
    } catch (error) {
      if (!String(error).includes("config_payment_in_progress") || attempt === 4) {
        throw error;
      }
      await wait(1_000);
    }
  }
  assert(response?.session?.id, "session create response did not include an id");
  const sessionId = String(response.session.id);
  return await waitForSession(sessionId, "active", Number(process.env.HS_CONFIG_MATRIX_SESSION_TIMEOUT_MS || "180000"));
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
  await waitForSession(sessionId, "revoked", Number(process.env.HS_CONFIG_MATRIX_CLEANUP_TIMEOUT_MS || "180000"));
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

function materializeConfig(configText, privateKey) {
  return privateKey
    ? configText.replace("<replace-with-matching-client-private-key>", privateKey)
    : configText;
}

function routeConfigForProbe(configText, ip) {
  return configText.replace(/^AllowedIPs\s*=\s*(.+)$/m, (_match, current) => {
    const values = String(current).split(",").map((value) => value.trim()).filter(Boolean);
    const wanted = `${ip}/32`;
    const narrowed = values.includes("0.0.0.0/0")
      ? [wanted]
      : values.includes(wanted)
        ? values
        : [...values, wanted];
    return `AllowedIPs = ${narrowed.join(", ")}`;
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

function recordCheck(scenarioResult, check) {
  if (check.expected === "success") {
    assert(check.actual.ok && check.actual.probe?.received > 0, `${check.id}: expected success`);
  }
  const entry = {
    id: check.id,
    status: "passed",
    expected: check.expected,
    detail: check.detail,
    probe: compactProbe(check.actual.probe)
  };
  scenarioResult.checks.push(entry);
  result.checks.push(entry);
}

function assertProbeFailed(probe, message) {
  assert(!probe.ok || probe.probe?.received === 0, message);
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

function summarizeChecks(checks) {
  return {
    total: checks.length,
    passed: checks.filter((check) => check.status === "passed").length,
    failed: checks.filter((check) => check.status === "failed").length
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

function nodeFromEnv(prefix, defaultKey) {
  return {
    key: process.env[`${prefix}_KEY`] || defaultKey,
    host: requiredEnv(`${prefix}_HOST`),
    publicIp: requiredEnv(`${prefix}_IP`)
  };
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
