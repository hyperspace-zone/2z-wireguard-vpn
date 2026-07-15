import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderGateTargets, writeTargetsAtomically } from "./render-gate-file-sd.mjs";

test("renders only enabled gates with non-sensitive labels", () => {
  const targets = renderGateTargets({
    gates: [
      {
        name: "gate-eu-lon-01",
        publicIpv4: "192.0.2.10",
        probeUrl: "https://gate-eu-lon-01.hyperspace.zone/.well-known/hyperspace-probe",
        desiredState: "Enabled",
        schedulable: true,
        doubleZero: { tenant: "not-exported" }
      },
      {
        name: "gate-eu-mad-01",
        publicIpv4: "192.0.2.20",
        desiredState: "Maintenance"
      }
    ]
  }, { cluster: "mainnet", port: 9100 });

  assert.deepEqual(targets, [{
    targets: ["192.0.2.10:9100"],
    labels: {
      cluster: "mainnet",
      role: "gate",
      gate: "gate-eu-lon-01",
      probe_host: "gate-eu-lon-01.hyperspace.zone",
      public_ipv4: "192.0.2.10",
      desired_state: "Enabled"
    }
  }]);
  assert.equal(JSON.stringify(targets).includes("tenant"), false);
});

test("writes a valid discovery file atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hyperspace-file-sd-"));
  const output = join(directory, "gates.json");
  await writeTargetsAtomically(output, [{ targets: ["192.0.2.10:9100"], labels: { gate: "gate-a" } }]);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), [
    { targets: ["192.0.2.10:9100"], labels: { gate: "gate-a" } }
  ]);
});
