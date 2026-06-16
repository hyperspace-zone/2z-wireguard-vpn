import { parseAes256GcmKey } from "@hyperspace-zone/shared";
import type { ReconcileLoopRuntimeConfig } from "./loops/reconcile-loop.js";

export interface ControlPlaneWorkerConfig extends ReconcileLoopRuntimeConfig {
  databaseUrl: string;
  pollMs: number;
  workerId: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControlPlaneWorkerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const artifactEncryptionKeyRaw = env.ARTIFACT_ENCRYPTION_KEY;
  if (!artifactEncryptionKeyRaw) {
    throw new Error("ARTIFACT_ENCRYPTION_KEY is required");
  }

  return {
    databaseUrl,
    artifactEncryptionKey: parseAes256GcmKey(artifactEncryptionKeyRaw),
    pollMs: Number(env.WORKER_POLL_MS ?? 2000),
    workerId: env.WORKER_ID ?? `worker-${process.pid}`,
    gateHeartbeatStaleSeconds: Number(env.GATE_HEARTBEAT_STALE_SECONDS ?? 45),
    provisioningTimeoutSeconds: Number(env.PROVISIONING_TIMEOUT_SECONDS ?? 90),
    benchmarkProbesEnabled: env.BENCHMARK_PROBES_ENABLED !== "false",
    benchmarkIntervalSeconds: Number(env.BENCHMARK_INTERVAL_SECONDS ?? 300),
    benchmarkProbePort: Number(env.BENCHMARK_PROBE_PORT ?? 19192),
    benchmarkProbeCount: Number(env.BENCHMARK_PROBE_COUNT ?? 10),
    benchmarkProbeIntervalMs: Number(env.BENCHMARK_PROBE_INTERVAL_MS ?? 100),
    benchmarkProbeTimeoutMs: Number(env.BENCHMARK_PROBE_TIMEOUT_MS ?? 1000)
  };
}
