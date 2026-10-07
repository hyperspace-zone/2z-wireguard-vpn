import { createDatabase } from "@hyperspace-zone/db";
import { createHealthRegistry, createRuntimeMetrics } from "@hyperspace-zone/shared";
import { createWorkerObservabilityServer } from "./observability/server.js";
import { runProbesWorker } from "./probes/runner.js";
import { attachMeasurementStore, MongoMeasurementStore } from "@hyperspace-zone/control-plane";

const env = process.env;
if (!env.PROBES_DATABASE_URL || !env.PROBES_CATALOG_DATABASE_URL) throw new Error("Separate probes and read-only core catalog URLs are required");
if (env.PROBES_DATABASE_URL === env.PROBES_CATALOG_DATABASE_URL) throw new Error("Probes must not write to core");
const core = createDatabase({ connectionString: env.PROBES_CATALOG_DATABASE_URL, applicationName: "hyperspace-probes-catalog-readonly", maxConnections: 1, connectionTimeoutMs: 1500, statementTimeoutMs: 2000 });
const probes = createDatabase({ connectionString: env.PROBES_DATABASE_URL, applicationName: "hyperspace-probes-worker", maxConnections: 3, connectionTimeoutMs: 1500, statementTimeoutMs: 3000 });
const measurements = env.MEASUREMENTS_MONGO_URL ? new MongoMeasurementStore(env.MEASUREMENTS_MONGO_URL, env.MEASUREMENTS_MONGO_CA_FILE) : undefined;
if (measurements) attachMeasurementStore(probes, measurements);
const health = createHealthRegistry("probes-worker");
const metrics = createRuntimeMetrics({ service: "probes-worker" });
const controller = new AbortController();
const server = createWorkerObservabilityServer({ host: env.PROBES_OBSERVABILITY_HOST ?? "127.0.0.1", port: Number(env.PROBES_OBSERVABILITY_PORT ?? 9092), health, metrics });
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());
await server.start();
try {
  await runProbesWorker({ core, probes, health, metrics, signal: controller.signal, config: {
    benchmarkProbesEnabled: env.BENCHMARK_PROBES_ENABLED !== "false",
    benchmarkIntervalSeconds: Number(env.BENCHMARK_INTERVAL_SECONDS ?? 300),
    benchmarkProbePort: Number(env.BENCHMARK_PROBE_PORT ?? 19192),
    benchmarkProbeCount: Number(env.BENCHMARK_PROBE_COUNT ?? 10),
    benchmarkProbeIntervalMs: Number(env.BENCHMARK_PROBE_INTERVAL_MS ?? 100),
    benchmarkProbeTimeoutMs: Number(env.BENCHMARK_PROBE_TIMEOUT_MS ?? 1000),
    ntpDiscoveryEnabled: env.NTP_DISCOVERY_ENABLED === "true",
    ntpDiscoveryIntervalSeconds: Number(env.NTP_DISCOVERY_INTERVAL_SECONDS ?? 86400),
    ntpDiscoverySampleSeconds: Number(env.NTP_DISCOVERY_SAMPLE_SECONDS ?? 30),
    ntpDiscoveryMaxCandidates: Number(env.NTP_DISCOVERY_MAX_CANDIDATES ?? 96),
    tradingProbesEnabled: env.TRADING_PROBES_ENABLED === "true"
  } });
} finally { await server.stop(); await Promise.all([core.close(), probes.close(), measurements?.close()]); metrics.stop(); }
