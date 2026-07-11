import { parseAes256GcmKey } from "@hyperspace-zone/shared";
import type { BillingConfig } from "@hyperspace-zone/control-plane";
import type { ReconcileLoopRuntimeConfig } from "./loops/reconcile-loop.js";

export interface ControlPlaneWorkerConfig extends ReconcileLoopRuntimeConfig {
  databaseUrl: string;
  pollMs: number;
  workerId: string;
  observabilityHost: string;
  observabilityPort: number;
  solanaTopupReconcileIntervalSeconds: number;
  billing: BillingConfig;
  doubleZeroMetering: {
    url: string;
    bearerToken: string;
    sourceName: string;
    cluster: string;
    tenant: string;
    intervalSeconds: number;
  };
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
    observabilityHost: env.WORKER_OBSERVABILITY_HOST ?? "0.0.0.0",
    observabilityPort: Number(env.WORKER_OBSERVABILITY_PORT ?? 9091),
    solanaTopupReconcileIntervalSeconds: Number(env.SOLANA_TOPUP_RECONCILE_INTERVAL_SECONDS ?? 15),
    billing: {
      currency: env.BILLING_CURRENCY ?? "USD",
      solanaTreasuryAddress: env.SOLANA_TREASURY_ADDRESS ?? "",
      solanaTokenSymbol: env.SOLANA_TOKEN_SYMBOL ?? "USDC",
      solanaTokenMint: env.SOLANA_TOKEN_MINT ?? "",
      solanaRpcUrl: env.SOLANA_RPC_URL ?? "",
      solanaTokenBaseUnitsPerBillingMinor: Number(env.SOLANA_TOKEN_BASE_UNITS_PER_BILLING_MINOR ?? 10_000),
      solanaTokenDecimals: Number(env.SOLANA_TOKEN_DECIMALS ?? 6),
      topupIntentTtlSeconds: Number(env.TOPUP_INTENT_TTL_SECONDS ?? 3600),
      allowUnverifiedTopups: false,
      usageMarkupBps: Number(env.BILLING_USAGE_MARKUP_BPS ?? 1500)
    },
    doubleZeroMetering: {
      url: env.DOUBLEZERO_METERING_URL ?? "",
      bearerToken: env.DOUBLEZERO_METERING_BEARER_TOKEN ?? "",
      sourceName: env.DOUBLEZERO_METERING_SOURCE_NAME ?? "doublezero-hyperspace",
      cluster: env.DOUBLEZERO_METERING_CLUSTER ?? "mainnet-beta",
      tenant: env.DOUBLEZERO_METERING_TENANT ?? "hyperspace",
      intervalSeconds: Number(env.DOUBLEZERO_METERING_INTERVAL_SECONDS ?? 300)
    },
    gateHeartbeatStaleSeconds: Number(env.GATE_HEARTBEAT_STALE_SECONDS ?? 45),
    provisioningTimeoutSeconds: Number(env.PROVISIONING_TIMEOUT_SECONDS ?? 90),
    benchmarkProbesEnabled: env.BENCHMARK_PROBES_ENABLED !== "false",
    benchmarkIntervalSeconds: Number(env.BENCHMARK_INTERVAL_SECONDS ?? 300),
    benchmarkProbePort: Number(env.BENCHMARK_PROBE_PORT ?? 19192),
    benchmarkProbeCount: Number(env.BENCHMARK_PROBE_COUNT ?? 10),
    benchmarkProbeIntervalMs: Number(env.BENCHMARK_PROBE_INTERVAL_MS ?? 100),
    benchmarkProbeTimeoutMs: Number(env.BENCHMARK_PROBE_TIMEOUT_MS ?? 1000),
    ntpDiscoveryEnabled: env.NTP_DISCOVERY_ENABLED === "true",
    ntpDiscoveryIntervalSeconds: Number(env.NTP_DISCOVERY_INTERVAL_SECONDS ?? 86400),
    ntpDiscoverySampleSeconds: Number(env.NTP_DISCOVERY_SAMPLE_SECONDS ?? 30),
    ntpDiscoveryMaxCandidates: Number(env.NTP_DISCOVERY_MAX_CANDIDATES ?? 96)
  };
}
