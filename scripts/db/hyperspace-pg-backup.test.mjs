import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./hyperspace-pg-backup", import.meta.url);

test("PostgreSQL backup script is valid Bash", async () => {
  await execFileAsync("bash", ["-n", scriptUrl.pathname]);
});

test("offsite success is recorded only after verification, upload, check, and retention", async () => {
  const source = await readFile(scriptUrl, "utf8");
  const dump = source.indexOf('pg_dump --format=custom');
  const verify = source.indexOf('pg_restore --list "$tmp"');
  const localRetention = source.indexOf('find "$backup_dir"');
  const upload = source.indexOf("restic backup");
  const check = source.indexOf("restic check");
  const forget = source.indexOf("restic forget");
  const success = source.indexOf('printf \'%s\\n\' "$(date +%s)"');

  assert.ok(dump >= 0, "custom-format dump is missing");
  assert.ok(verify > dump, "local dump must be verified after creation");
  assert.ok(localRetention > verify, "local retention must follow local verification");
  assert.ok(upload > localRetention, "local retention must not depend on offsite availability");
  assert.ok(upload > verify, "offsite upload must follow local verification");
  assert.ok(check > upload, "repository check must follow upload");
  assert.ok(forget > check, "retention must follow repository check");
  assert.ok(success > forget, "offsite success must be recorded last");
});

test("offsite backups include cluster globals and require encrypted Restic credentials", async () => {
  const source = await readFile(scriptUrl, "utf8");
  assert.match(source, /pg_dumpall --globals-only/);
  assert.match(source, /RESTIC_PASSWORD is required/);
  assert.match(source, /--keep-daily/);
  assert.match(source, /--keep-weekly/);
});
