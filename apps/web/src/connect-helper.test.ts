import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { connectHelperScript } from "./connect-helper.js";

for (const protocol of ["amneziawg", "wireguard"]) {
  test(`Linux connect helper dispatches downloaded ${protocol} configuration to its matching tool`, () => {
    const dir = mkdtempSync(join(tmpdir(), "connect-helper-"));
    try {
      const fixture = join(dir, "fixture");
      const log = join(dir, "commands");
      writeFileSync(fixture, `[Interface]\nPrivateKey = fixture-secret\n${protocol === "amneziawg" ? "HeaderProtectionKey = fixture-obfuscation-key\n" : ""}`);
      writeFileSync(join(dir, "curl"), '#!/bin/sh\nwhile [ "$1" != -o ]; do shift; done\ncp "$CONFIG_FIXTURE" "$2"\n', { mode: 0o755 });
      writeFileSync(join(dir, "sudo"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMAND_LOG"\n', { mode: 0o755 });
      for (const tool of ["awg-quick", "wg-quick"]) writeFileSync(join(dir, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const result = spawnSync("bash", ["-s"], {
        input: connectHelperScript("linux", "https://example.test/config"), encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CONFIG_FIXTURE: fixture, COMMAND_LOG: log }
      });
      assert.equal(result.status, 0, result.stderr);
      const commands = readFileSync(log, "utf8");
      assert.ok(commands.includes(protocol === "amneziawg" ? "awg-quick up /etc/amnezia/amneziawg/hyperspace.conf" : "wg-quick up /etc/wireguard/hyperspace.conf"));
      assert.ok(!commands.includes(protocol === "amneziawg" ? "\nwg-quick " : "\nawg-quick "));
      assert.ok(!`${commands}${result.stdout}${result.stderr}`.includes("fixture-secret"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
