import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./hyperspace-pg-backup", import.meta.url);
const serviceUrl = new URL("../../infra/systemd/hyperspace-db-backup.service", import.meta.url);

async function createHarness(availableBytes = "1000000000") {
  const root = await mkdtemp(join(tmpdir(), "hyperspace-pg-backup-"));
  const backupDir = join(root, "backups");
  const binDir = join(root, "bin");
  await mkdir(backupDir);
  await mkdir(binDir);

  const commands = {
    df: `#!/bin/sh
printf 'Filesystem 1-blocks Used Available Capacity Mounted on\\n'
printf 'fixture 1000000000 0 %s 0%% %s\\n' "$HS_TEST_AVAILABLE_BYTES" "$4"
`,
    pg_dump: `#!/bin/sh
for argument in "$@"; do
  case "$argument" in --file=*) output="\${argument#--file=}" ;; esac
done
test -n "$output"
printf 'verified custom dump\\n' >"$output"
`,
    pg_dumpall: `#!/bin/sh
printf '%s\\n' "$@" >"$HS_TEST_GLOBALS_ARGUMENTS"
for argument in "$@"; do
  case "$argument" in --file=*) output="\${argument#--file=}" ;; esac
done
test -n "$output"
printf '%s\\n' '-- PostgreSQL globals' >"$output"
`,
    pg_restore: "#!/bin/sh\nexit 0\n",
    psql: "#!/bin/sh\nprintf '1000000\\n'\n"
  };
  for (const [name, body] of Object.entries(commands)) {
    const path = join(binDir, name);
    await writeFile(path, body);
    await chmod(path, 0o755);
  }

  return {
    root,
    backupDir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      HS_DB_NAME: "hyperspace",
      HS_DB_BACKUP_DIR: backupDir,
      HS_DB_BACKUP_KEEP_LAST: "3",
      HS_DB_BACKUP_REQUIRED_FREE_BYTES: "1",
      HS_TEST_AVAILABLE_BYTES: availableBytes,
      HS_TEST_GLOBALS_ARGUMENTS: join(root, "globals-arguments")
    }
  };
}

async function addManagedBackup(backupDir, stamp) {
  await writeFile(join(backupDir, `hyperspace-${stamp}.dump`), `dump ${stamp}\n`);
  await writeFile(join(backupDir, `hyperspace-globals-${stamp}.sql`), `globals ${stamp}\n`);
}

test("PostgreSQL backup script is valid Bash", async () => {
  await execFileAsync("bash", ["-n", scriptUrl.pathname]);
});

test("R2 failure preserves the local dump but never advances offsite success", async () => {
  const fixture = await createHarness();
  try {
    const helper = join(fixture.root, 'r2-fail');
    await writeFile(helper, '#!/bin/sh\nexit 1\n', {mode: 0o755});
    const success = join(fixture.root, 'offsite-success');
    await assert.rejects(execFileAsync(scriptUrl.pathname, [], {env: {...fixture.env,
      HS_DB_OFFSITE_BACKUP_MODE: 'r2', HS_R2_HELPER: helper, HS_DB_OFFSITE_SUCCESS_FILE: success}}));
    assert.equal((await readdir(fixture.backupDir)).filter(x => x.endsWith('.dump')).length, 1);
    await assert.rejects(readFile(success));
  } finally { await rm(fixture.root, {recursive: true, force: true}); }
});

test("managed backups avoid password hashes and use the explicit database", async () => {
  const fixture = await createHarness();
  try {
    await execFileAsync(scriptUrl.pathname, [], { env: { ...fixture.env, HS_POSTGRES_MANAGED: "1" } });
    const args = await readFile(fixture.env.HS_TEST_GLOBALS_ARGUMENTS, "utf8");
    assert.match(args, /--no-role-passwords/);
    assert.match(args, /--database=hyperspace/);
    assert.equal((await readdir(fixture.backupDir)).filter(x => x.endsWith(".dump")).length, 1);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("PostgreSQL backup runs with bounded CPU and low I/O priority", async () => {
  const service = await readFile(serviceUrl, "utf8");
  assert.match(service, /^Nice=15$/m);
  assert.match(service, /^IOSchedulingClass=best-effort$/m);
  assert.match(service, /^IOSchedulingPriority=7$/m);
  assert.match(service, /^CPUQuota=25%$/m);
});

test("offsite success is recorded only after verification, upload, check, and retention", async () => {
  const source = await readFile(scriptUrl, "utf8");
  const dump = source.indexOf('pg_dump --format=custom');
  const verify = source.indexOf('pg_restore --list "$tmp"');
  const preflight = source.indexOf('ensure_backup_capacity');
  const localRetention = source.indexOf('prune_managed_backups "$keep_last"', verify);
  const upload = source.indexOf("restic backup");
  const check = source.indexOf("restic check");
  const forget = source.indexOf("restic forget");
  const success = source.indexOf('printf \'%s\\n\' "$(date +%s)"');

  assert.ok(dump >= 0, "custom-format dump is missing");
  assert.ok(preflight < dump, "capacity must be checked before creating the dump");
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
  assert.match(source, /--group-by host,tags/);
  assert.match(source, /--keep-daily/);
  assert.match(source, /--keep-weekly/);
});

test("filesystem offsite backups fail closed unless the backup directory is the expected mount", async () => {
  const source = await readFile(scriptUrl, "utf8");
  const mountCheck = source.indexOf('findmnt --noheadings --target "$backup_dir"');
  const createBackupDirectory = source.indexOf('install -d -m 0700 "$backup_dir"');
  const dump = source.indexOf("pg_dump --format=custom");
  const sync = source.indexOf('sync -f "$final"');
  const success = source.indexOf('printf \'%s\\n\' "$(date +%s)"');

  assert.ok(mountCheck >= 0, "filesystem mount validation is missing");
  assert.ok(mountCheck < createBackupDirectory, "mount validation must precede local directory creation");
  assert.ok(createBackupDirectory < dump, "mount validation must precede the PostgreSQL dump");
  assert.match(source, /\[\[ -w "\$backup_dir" \]\]/);
  assert.ok(sync > dump, "filesystem backup must be flushed after dump verification");
  assert.ok(success > sync, "offsite success must follow the filesystem flush");
});

test("managed retention keeps the newest three verified dumps and ignores manual snapshots", async () => {
  const fixture = await createHarness();
  try {
    for (const stamp of [
      "20260901T020000Z",
      "20260902T020000Z",
      "20260903T020000Z",
      "20260904T020000Z",
      "20260905T020000Z"
    ]) {
      await addManagedBackup(fixture.backupDir, stamp);
    }
    const manual = "hyperspace-pre-trading-20260905T120000Z.dump";
    await writeFile(join(fixture.backupDir, manual), "manual snapshot\n");

    await execFileAsync(scriptUrl.pathname, [], { env: fixture.env });

    const files = await readdir(fixture.backupDir);
    const dumps = files.filter((name) => /^hyperspace-\d{8}T\d{6}Z\.dump$/u.test(name)).sort();
    const globals = files.filter((name) => /^hyperspace-globals-\d{8}T\d{6}Z\.sql$/u.test(name)).sort();
    assert.equal(dumps.length, 3);
    assert.equal(globals.length, 3);
    assert.ok(dumps.some((name) => name.includes("20260904T020000Z")));
    assert.ok(dumps.some((name) => name.includes("20260905T020000Z")));
    assert.ok(files.includes(manual), "manual snapshots must not be pruned");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("capacity guard preserves the newest known-good dump", async () => {
  const fixture = await createHarness("1");
  fixture.env.HS_DB_BACKUP_REQUIRED_FREE_BYTES = "1000";
  try {
    await addManagedBackup(fixture.backupDir, "20260901T020000Z");
    await addManagedBackup(fixture.backupDir, "20260902T020000Z");

    await assert.rejects(
      execFileAsync(scriptUrl.pathname, [], { env: fixture.env }),
      /insufficient backup capacity/u
    );

    const files = await readdir(fixture.backupDir);
    assert.ok(!files.includes("hyperspace-20260901T020000Z.dump"));
    assert.ok(files.includes("hyperspace-20260902T020000Z.dump"));
    assert.ok(files.includes("hyperspace-globals-20260902T020000Z.sql"));
    assert.equal(files.filter((name) => /^hyperspace-\d{8}T\d{6}Z\.dump$/u.test(name)).length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
