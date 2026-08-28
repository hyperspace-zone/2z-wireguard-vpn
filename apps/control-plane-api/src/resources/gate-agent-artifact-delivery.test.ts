import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { encodeGateAgentArtifact } from "./gate-agent-artifact-delivery.js";

test("gate-agent artifacts use gzip when the client supports it", async () => {
  const artifact = Buffer.alloc(1024 * 1024, "hyperspace-gate-agent");
  const response = await encodeGateAgentArtifact(artifact, "gzip");

  assert.equal(response.contentEncoding, "gzip");
  assert(response.data.length < artifact.length);
  assert.deepEqual(gunzipSync(response.data), artifact);
});

test("gate-agent artifacts remain byte-identical when gzip is unavailable or disabled", async () => {
  const artifact = Buffer.from("gate-agent-artifact");

  assert.deepEqual(await encodeGateAgentArtifact(artifact, undefined), { data: artifact });
  assert.deepEqual(await encodeGateAgentArtifact(artifact, "gzip;q=0, identity"), { data: artifact });
});
