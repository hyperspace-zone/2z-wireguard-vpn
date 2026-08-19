import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const releaseManager = join(repoRoot, "scripts/hyperspace-gate-agent-release");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fakeAgent(path, version, selfTestSucceeds = true) {
  writeFileSync(path, `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --self-test) ${selfTestSucceeds ? "exit 0" : "exit 1"} ;;
  --build-info)
    sha=$(sha256sum "$0" | awk '{print $1}')
    printf '{"version":"${version}","revision":"${version}-revision","builtAt":"2026-08-19T00:00:00Z","artifactSha256":"%s"}\\n' "$sha"
    ;;
  *) exit 0 ;;
esac
`);
  chmodSync(path, 0o755);
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hyperspace-agent-release-"));
  const binDirectory = join(directory, "bin");
  const etcDirectory = join(directory, "etc");
  const stateDirectory = join(directory, "state");
  mkdirSync(binDirectory);
  mkdirSync(etcDirectory);
  mkdirSync(stateDirectory);
  const agent = join(binDirectory, "hyperspace-gate-agent");
  const unit = join(etcDirectory, "hyperspace-gate-agent.service");
  const envFile = join(etcDirectory, "gate-agent.env");
  const systemctl = join(binDirectory, "systemctl");
  const curl = join(binDirectory, "curl");
  const curlLog = join(directory, "curl.log");
  const failedOnce = join(directory, "failed-once");
  fakeAgent(agent, "old");
  writeFileSync(unit, "[Service]\nExecStart=/test/agent\n");
  writeFileSync(envFile, "CONTROL_PLANE_URL=https://control-plane.example.test\nGATE_NAME=gate-eu-test-01\nGATE_TOKEN=test-token\n");
  writeFileSync(systemctl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "restart" ]] && grep -q 'bad-activation' "\${FAKE_AGENT_PATH}" && [[ ! -e "\${FAKE_FAILED_ONCE}" ]]; then
  touch "\${FAKE_FAILED_ONCE}"
  exit 1
fi
exit 0
`);
  chmodSync(systemctl, 0o755);
  writeFileSync(curl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"\${FAKE_CURL_LOG}"
printf '{"agentArtifactSha256":"%s"}\\n' "\${FAKE_EXPECTED_SHA}"
`);
  chmodSync(curl, 0o755);
  return { directory, agent, unit, envFile, stateDirectory, systemctl, curl, curlLog, failedOnce };
}

function install(files, candidate, extraEnv = {}) {
  return spawnSync(releaseManager, [
    "install",
    "--candidate", candidate,
    "--unit", files.unit,
    "--expected-sha", sha256(candidate)
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HYPERSPACE_AGENT_PATH: files.agent,
      HYPERSPACE_AGENT_UNIT_PATH: files.unit,
      HYPERSPACE_AGENT_ENV_PATH: files.envFile,
      HYPERSPACE_AGENT_RELEASE_STATE_DIR: files.stateDirectory,
      HYPERSPACE_SYSTEMCTL_BIN: files.systemctl,
      HYPERSPACE_CURL_BIN: files.curl,
      HYPERSPACE_RELEASE_SKIP_CP_CONFIRMATION: "true",
      HYPERSPACE_AGENT_ACTIVATION_TIMEOUT_SECONDS: "1",
      FAKE_AGENT_PATH: files.agent,
      FAKE_FAILED_ONCE: files.failedOnce,
      FAKE_CURL_LOG: files.curlLog,
      FAKE_EXPECTED_SHA: sha256(candidate),
      ...extraEnv
    }
  });
}

test("release manager records and activates a self-tested immutable artifact", () => {
  const files = fixture();
  const candidate = join(files.directory, "candidate");
  fakeAgent(candidate, "candidate");
  const expectedSha = sha256(candidate);

  const result = install(files, candidate);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(sha256(files.agent), expectedSha);
  const metadata = JSON.parse(readFileSync(join(files.stateDirectory, "agent-release.json"), "utf8"));
  assert.equal(metadata.artifactSha256, expectedSha);
  assert.match(metadata.installedAt, /^2026-/);
  const events = readFileSync(join(files.stateDirectory, "agent-deployments.jsonl"), "utf8");
  assert.match(events, /"phase":"activating"/);
  assert.match(events, /"phase":"succeeded"/);
});

test("release manager rejects an artifact whose built-in nft self-test fails", () => {
  const files = fixture();
  const previousSha = sha256(files.agent);
  const candidate = join(files.directory, "candidate");
  fakeAgent(candidate, "broken", false);

  const result = install(files, candidate);
  assert.notEqual(result.status, 0);
  assert.equal(sha256(files.agent), previousSha);
});

test("release manager automatically restores the previous artifact when activation fails", () => {
  const files = fixture();
  const previousSha = sha256(files.agent);
  const candidate = join(files.directory, "candidate");
  fakeAgent(candidate, "bad-activation");

  const result = install(files, candidate);
  assert.notEqual(result.status, 0);
  assert.equal(sha256(files.agent), previousSha);
  const events = readFileSync(join(files.stateDirectory, "agent-deployments.jsonl"), "utf8");
  assert.match(events, /"phase":"activation_failed"/);
  assert.match(events, /"phase":"rolled_back"/);
});

test("release manager confirms the installed SHA with gate authentication headers", () => {
  const files = fixture();
  const candidate = join(files.directory, "candidate");
  fakeAgent(candidate, "candidate");

  const result = install(files, candidate, { HYPERSPACE_RELEASE_SKIP_CP_CONFIRMATION: "false" });

  assert.equal(result.status, 0, result.stderr);
  const curlArguments = readFileSync(files.curlLog, "utf8");
  assert.match(curlArguments, /X-Gate-Name: gate-eu-test-01/);
  assert.match(curlArguments, /X-Gate-Token: test-token/);
  assert.match(curlArguments, /https:\/\/control-plane\.example\.test\/v1\/gate\/runtime/);
});
