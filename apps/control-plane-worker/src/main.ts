import { createDatabase } from "@hyperspace-zone/db";
import { createHealthRegistry, createRuntimeMetrics } from "@hyperspace-zone/shared";
import { loadConfig } from "./config.js";
import { createWorkerObservabilityServer } from "./observability/server.js";
import { createWorkerRunner } from "./runners/worker-runner.js";

const config = loadConfig();
const db = createDatabase({
  connectionString: config.databaseUrl,
  applicationName: "hyperspace-control-plane-worker"
});
// Observability must not hold the operational pool or run unbounded historical
// scans. A slow collector keeps its last gauges and reports degraded health.
const metricsDb = createDatabase({
  connectionString: config.databaseUrl,
  applicationName: "hyperspace-control-plane-worker-metrics",
  maxConnections: 1,
  statementTimeoutMs: 2000
});
const health = createHealthRegistry("control-plane-worker");
const metrics = createRuntimeMetrics({ service: "control-plane-worker" });
metrics.gauge("control_plane_snapshot_ready", 0, {
  help: "Whether the worker has collected a complete control-plane business metrics snapshot."
});
health.setComponent("process", { state: "starting", message: "Worker process is starting." });
health.setComponent("configuration", { state: "ready", message: "Runtime configuration loaded." });
const observability = createWorkerObservabilityServer({
  host: config.observabilityHost,
  port: config.observabilityPort,
  health,
  metrics
});
const runner = createWorkerRunner({
  db,
  metricsDb,
  config,
  health,
  metrics
});

process.on("SIGTERM", () => {
  void runner.stop()
    .then(() => metricsDb.close())
    .then(() => observability.stop())
    .then(() => metrics.stop())
    .then(() => process.exit(0));
});

await observability.start();
health.setComponent("process", {
  state: "ready",
  message: "Worker process is running.",
  details: {
    observabilityHost: config.observabilityHost,
    observabilityPort: config.observabilityPort
  }
});
await runner.start();
