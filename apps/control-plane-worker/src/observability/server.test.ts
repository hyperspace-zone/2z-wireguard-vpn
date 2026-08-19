import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { createHealthRegistry, createRuntimeMetrics } from "@hyperspace-zone/shared";
import { createWorkerObservabilityServer } from "./server.js";

test("metrics stays scrapeable before the first complete business snapshot", async () => {
  const port = await reservePort();
  const metrics = createRuntimeMetrics({ service: "worker-test", flushIntervalMs: 60_000 });
  metrics.gauge("control_plane_snapshot_ready", 0, {
    help: "Whether the worker has collected a complete control-plane business metrics snapshot."
  });
  const server = createWorkerObservabilityServer({
    host: "127.0.0.1",
    port,
    health: createHealthRegistry("worker-test"),
    metrics
  });

  try {
    await server.start();
    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /hyperspace_control_plane_snapshot_ready\{service="worker-test"\} 0/);
  } finally {
    await server.stop();
    metrics.stop();
  }
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  if (!address || typeof address === "string") {
    throw new Error("failed to reserve a local TCP port");
  }
  return address.port;
}
