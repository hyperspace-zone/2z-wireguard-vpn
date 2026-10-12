import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scriptUrl = new URL("./restart-after-migrations", import.meta.url);
const prepareScriptUrl = new URL("./prepare-runtime-tree", import.meta.url);
const apiUnitUrl = new URL("../../infra/systemd/hyperspace-control-plane-api.service", import.meta.url);
const workerUnitUrl = new URL("../../infra/systemd/hyperspace-control-plane-worker.service", import.meta.url);

test("control-plane deployment shell helpers have valid syntax", () => {
  for (const script of [scriptUrl, prepareScriptUrl]) {
    const result = spawnSync("bash", ["-n", script.pathname], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("migration apply and verification precede both service restarts", async () => {
  const source = await readFile(scriptUrl, "utf8");
  const prepare = source.indexOf('"$runtime_prepare"');
  const apply = source.indexOf('run_as_service npm --prefix "$repo_dir" run db:migrate');
  const verify = source.indexOf('run_as_service node "$repo_dir/packages/db/dist/migrate.js"');
  const restart = source.indexOf("systemctl restart hyperspace-control-plane-api.service");

  assert.ok(prepare >= 0, "runtime permission preparation command is missing");
  assert.ok(apply > prepare, "runtime permissions must be repaired before migrations");
  assert.ok(apply >= 0, "migration apply command is missing");
  assert.ok(verify > apply, "migration verification must follow migration apply");
  assert.ok(restart > verify, "services must restart only after migration verification");
});

test("failed migration verification exits before restart", async () => {
  const source = await readFile(scriptUrl, "utf8");
  assert.match(source, /migration verification failed; API and worker were not restarted/);
  assert.match(source, /\.ok == true and \(\.applied \| length == 0\)/);
});

test("runtime preparation covers every API and worker build dependency", async () => {
  const source = await readFile(prepareScriptUrl, "utf8");
  for (const runtimeDir of [
    "apps/control-plane-api/dist",
    "apps/control-plane-worker/dist",
    "packages/contracts/dist",
    "packages/control-plane/dist",
    "packages/db/dist",
    "packages/shared/dist",
  ]) {
    assert.match(source, new RegExp(runtimeDir.replaceAll("/", "\\/")));
  }
  assert.match(source, /chown -R --no-dereference/);
  assert.match(source, /chmod -R u=rwX,go=rX/);
  assert.match(source, /runuser -u "\$service_user" -- test -r/);
});

test("runtime preparation repairs restrictive root-owned artifacts", async (t) => {
  if (process.getuid?.() !== 0 || spawnSync("id", ["nobody"]).status !== 0) {
    t.skip("requires root and the nobody service account");
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "hyperspace-runtime-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);
  await writeFile(join(root, "package.json"), "{}\n", { mode: 0o600 });

  const runtimeDirs = [
    "apps/control-plane-api/dist",
    "apps/control-plane-worker/dist",
    "packages/contracts/dist",
    "packages/control-plane/dist",
    "packages/db/dist",
    "packages/shared/dist",
  ];
  for (const relativeDir of runtimeDirs) {
    const runtimeDir = join(root, relativeDir);
    await mkdir(runtimeDir, { recursive: true, mode: 0o755 });
    await chmod(runtimeDir, 0o700);
  }
  for (const relativeFile of [
    "apps/control-plane-api/dist/main.js",
    "apps/control-plane-worker/dist/main.js",
    "packages/db/dist/index.js",
    "packages/db/dist/migrate.js",
  ]) {
    await writeFile(join(root, relativeFile), "export {};\n", { mode: 0o600 });
  }

  const result = spawnSync(
    prepareScriptUrl.pathname,
    ["--repo-dir", root, "--service-user", "nobody"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);

  const expectedUid = Number(spawnSync("id", ["-u", "nobody"], { encoding: "utf8" }).stdout.trim());
  const directory = await stat(join(root, "packages/db/dist"));
  const entrypoint = await stat(join(root, "packages/db/dist/index.js"));
  assert.equal(directory.uid, expectedUid);
  assert.equal(directory.mode & 0o777, 0o755);
  assert.equal(entrypoint.uid, expectedUid);
  assert.equal(entrypoint.mode & 0o777, 0o644);
});

test("API and worker self-heal runtime permissions before every start", async () => {
  const expected = "ExecStartPre=+/usr/local/sbin/hyperspace-control-plane-prepare-runtime";
  for (const unit of [apiUnitUrl, workerUnitUrl]) {
    const source = await readFile(unit, "utf8");
    assert.ok(source.includes(expected), `${unit.pathname} is missing the runtime preflight`);
  }
});
