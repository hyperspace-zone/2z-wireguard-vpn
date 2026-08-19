import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = resolve("scripts/gates/control-plane-rollout.mjs");

test("control-plane rollout dry-run validates the artifact and orders the canary first", () => {
  const directory = mkdtempSync(join(tmpdir(), "hyperspace-control-plane-rollout-"));
  const binary = join(directory, "hyperspace-gate-agent");
  writeFileSync(binary, `#!/bin/sh
set -eu
if [ "\${1:-}" = "--build-info" ]; then
  sha=$(sha256sum "$0" | awk '{print $1}')
  printf '{"version":"0.2.2","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","builtAt":"2026-08-19T10:00:00Z","artifactSha256":"%s"}\\n' "$sha"
  exit 0
fi
if [ "\${1:-}" = "--self-test" ]; then exit 0; fi
exit 2
`);
  chmodSync(binary, 0o755);

  const result = spawnSync(process.execPath, [script,
    "--binary", binary,
    "--control-plane-url", "https://control-plane.example.test",
    "--admin-token-file", join(directory, "unused.token"),
    "--gate", "gate-b",
    "--gate", "gate-a",
    "--canary-gate", "gate-b"
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, "dry-run");
  assert.equal(output.canary, "gate-b");
  assert.deepEqual(output.gates, ["gate-b", "gate-a"]);
  assert.match(output.artifact.artifactSha256, /^[a-f0-9]{64}$/);
});
