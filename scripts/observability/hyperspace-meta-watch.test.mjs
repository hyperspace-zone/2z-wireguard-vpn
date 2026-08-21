import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = new URL("./hyperspace-meta-watch", import.meta.url).pathname;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hyperspace-meta-watch-"));
  const stateDir = join(root, "state");
  const metricsDir = join(root, "metrics");
  const tokenFile = join(root, "meta-token");
  const primaryTokenFile = join(root, "primary-token");
  const resendFile = join(root, "resend-token");
  const receiversFile = join(root, "receivers.json");
  const peersFile = join(root, "peers.tsv");
  const curlLog = join(root, "curl.log");
  const fakeCurl = join(root, "curl");

  await mkdir(stateDir);
  await mkdir(metricsDir);
  await writeFile(tokenFile, "meta-token\n");
  await writeFile(primaryTokenFile, "primary-token\n");
  await writeFile(resendFile, "resend-token\n");
  await writeFile(receiversFile, JSON.stringify({ receivers: [{ chatId: "366795" }] }));
  await writeFile(peersFile, "");
  await writeFile(
    fakeCurl,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >>${JSON.stringify(curlLog)}
printf '\\n' >>${JSON.stringify(curlLog)}
args="$*"
case "$args" in
  *primary-token/getMe*) printf '%s\\n' '{"ok":true,"result":{"id":123,"username":"PrimaryBot"}}' ;;
  *primary-token/getChat*) printf '%s\\n' '{"ok":true,"result":{"id":366795,"type":"private"}}' ;;
  *meta-token/getMe*) printf '%s\\n' '{"ok":true,"result":{"id":456,"username":"HyperspaceMetaWatcher_bot"}}' ;;
  *meta-token/getChat*) printf '%s\\n' '{"ok":true,"result":{"id":366795,"type":"private"}}' ;;
  *meta-token/sendMessage*) printf '%s\\n' '{"ok":true,"result":{"message_id":1}}' ;;
  *api.resend.com/emails*) printf '%s\\n' '{"id":"test-message"}' ;;
  *peer-down*) exit 22 ;;
  *'/-/ready'*) printf '%s\\n' 'OK' ;;
  *'/metrics'*) printf '%s\\n' 'alertmanager_notifications_failed_total{integration="telegram"} 0' ;;
  *) printf '%s\\n' '{}' ;;
esac
`,
  );
  await chmod(fakeCurl, 0o755);

  const env = {
    ...process.env,
    HS_META_CLUSTER: "unit-test",
    HS_META_TELEGRAM_BOT_TOKEN_FILE: tokenFile,
    HS_META_TELEGRAM_CHAT_ID: "366795",
    HS_META_TELEGRAM_USERNAME: "HyperspaceMetaWatcher_bot",
    HS_META_RESEND_API_KEY_FILE: resendFile,
    HS_META_EMAIL_TO: "gatekeepers@hyperspace.zone",
    HS_META_PRIMARY_TELEGRAM_BOT_TOKEN_FILE: primaryTokenFile,
    HS_META_PRIMARY_RECEIVERS_FILE: receiversFile,
    HS_META_PRIMARY_TELEGRAM_USERNAME: "PrimaryBot",
    HS_META_PEERS_FILE: peersFile,
    HS_META_STATE_DIR: stateDir,
    HS_META_METRICS_DIR: metricsDir,
    HS_META_CURL_BIN: fakeCurl,
  };

  return { root, stateDir, metricsDir, curlLog, env };
}

test("meta-watch shell syntax is valid", async () => {
  await execFileAsync("bash", ["-n", scriptPath]);
});

test("healthy run exports node-exporter textfile metrics", async () => {
  const f = await fixture();
  try {
    const { stdout } = await execFileAsync(scriptPath, ["run"], { env: f.env });
    assert.match(stdout, /meta-watch healthy for unit-test/);
    const metrics = await readFile(join(f.metricsDir, "hyperspace_meta_watch.prom"), "utf8");
    assert.match(metrics, /hyperspace_meta_watch_healthy 1/);
    assert.match(metrics, /hyperspace_meta_watch_failure_count 0/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("test mode delivers through independent Telegram and Resend channels", async () => {
  const f = await fixture();
  try {
    const { stdout } = await execFileAsync(scriptPath, ["test"], { env: f.env });
    assert.match(stdout, /Telegram and Resend test deliveries succeeded/);
    const log = await readFile(f.curlLog, "utf8");
    assert.match(log, /meta-token\/sendMessage/);
    assert.match(log, /api\.resend\.com\/emails/);
    assert.match(log, /366795/);
    assert.match(log, /gatekeepers%40hyperspace\.zone|gatekeepers@hyperspace\.zone/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("incident and recovery require two consecutive cycles and are deduplicated", async () => {
  const f = await fixture();
  try {
    const peersFile = f.env.HS_META_PEERS_FILE;
    await writeFile(peersFile, "broken-peer\thttps://peer-down.invalid/-/ready\n");

    await execFileAsync(scriptPath, ["run"], { env: f.env });
    let log = await readFile(f.curlLog, "utf8");
    assert.equal((log.match(/meta-token\/sendMessage/g) ?? []).length, 0);

    await execFileAsync(scriptPath, ["run"], { env: f.env });
    log = await readFile(f.curlLog, "utf8");
    assert.equal((log.match(/meta-token\/sendMessage/g) ?? []).length, 1);
    assert.equal((log.match(/api\.resend\.com\/emails/g) ?? []).length, 1);

    await execFileAsync(scriptPath, ["run"], { env: f.env });
    log = await readFile(f.curlLog, "utf8");
    assert.equal((log.match(/meta-token\/sendMessage/g) ?? []).length, 1);

    await writeFile(peersFile, "");
    await execFileAsync(scriptPath, ["run"], { env: f.env });
    log = await readFile(f.curlLog, "utf8");
    assert.equal((log.match(/meta-token\/sendMessage/g) ?? []).length, 1);

    await execFileAsync(scriptPath, ["run"], { env: f.env });
    log = await readFile(f.curlLog, "utf8");
    assert.equal((log.match(/meta-token\/sendMessage/g) ?? []).length, 2);
    assert.equal((log.match(/api\.resend\.com\/emails/g) ?? []).length, 2);
    const metrics = await readFile(join(f.metricsDir, "hyperspace_meta_watch.prom"), "utf8");
    assert.match(metrics, /hyperspace_meta_watch_healthy 1/);
    assert.match(metrics, /hyperspace_meta_watch_incident_active 0/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
