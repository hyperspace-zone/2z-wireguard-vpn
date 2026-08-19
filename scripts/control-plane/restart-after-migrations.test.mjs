import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptUrl = new URL("./restart-after-migrations", import.meta.url);

test("migration apply and verification precede both service restarts", async () => {
  const source = await readFile(scriptUrl, "utf8");
  const apply = source.indexOf('run_as_service npm --prefix "$repo_dir" run db:migrate');
  const verify = source.indexOf('run_as_service node "$repo_dir/packages/db/dist/migrate.js"');
  const restart = source.indexOf("systemctl restart hyperspace-control-plane-api.service");

  assert.ok(apply >= 0, "migration apply command is missing");
  assert.ok(verify > apply, "migration verification must follow migration apply");
  assert.ok(restart > verify, "services must restart only after migration verification");
});

test("failed migration verification exits before restart", async () => {
  const source = await readFile(scriptUrl, "utf8");
  assert.match(source, /migration verification failed; API and worker were not restarted/);
  assert.match(source, /\.ok == true and \(\.applied \| length == 0\)/);
});
