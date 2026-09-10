import { parseAes256GcmKey } from "@hyperspace-zone/shared";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { BillingConfig } from "@hyperspace-zone/control-plane";
import type { BenchmarkSchedulerRuntimeConfig } from "./loops/benchmark-scheduler-loop.js";
import type { ReconcileLoopRuntimeConfig } from "./loops/reconcile-loop.js";
import type { TradingProbeSchedulerRuntimeConfig } from "./loops/trading-probe-scheduler-loop.js";

export interface ControlPlaneWorkerConfig extends ReconcileLoopRuntimeConfig, BenchmarkSchedulerRuntimeConfig, TradingProbeSchedulerRuntimeConfig {
  databaseUrl: string;
  pollMs: number;
  benchmarkSchedulerPollMs: number;
  tradingProbeSchedulerPollMs: number;
  snapshotIntervalMs: number;
  workerId: string;
  observabilityHost: string;
  observabilityPort: number;
  solanaDepositReconcileIntervalSeconds: number;
  solanaDirectDepositScanIntervalSeconds: number;
  solanaDirectDepositScanBatchSize: number;
  heliusUsage: {
    projectId: string;
    intervalSeconds: number;
    adminApiBaseUrl: string;
  };
  billing: BillingConfig;
  retailBilling: {
    enabled: boolean;
    mode: "shadow" | "enforce";
    intervalSeconds: number;
    settlementLagSeconds: number;
    batchSize: number;
  };
  billingNotifications: {
    provider: "disabled" | "resend";
    resendApiKey: string;
    from: string;
    replyTo: string;
  };
  solanaWithdrawals: {
    enabled: boolean;
    intervalSeconds: number;
    custodialEncryptionKey: Buffer | null;
    feePayer: Keypair | null;
  };
  solanaRevenueSweeps: {
    enabled: boolean;
    intervalSeconds: number;
    treasuryAddress: string;
  };
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

  const nativeSolBilling = env.SOLANA_ASSET_KIND === "native";
  const config: ControlPlaneWorkerConfig = {
    databaseUrl,
    artifactEncryptionKey: parseAes256GcmKey(artifactEncryptionKeyRaw),
    pollMs: Number(env.WORKER_POLL_MS ?? 2000),
    benchmarkSchedulerPollMs: Number(env.BENCHMARK_SCHEDULER_POLL_MS ?? 15000),
    tradingProbeSchedulerPollMs: Number(env.TRADING_PROBE_SCHEDULER_POLL_MS ?? 5000),
    snapshotIntervalMs: Number(env.WORKER_SNAPSHOT_INTERVAL_MS ?? 15000),
    workerId: env.WORKER_ID ?? `worker-${process.pid}`,
    observabilityHost: env.WORKER_OBSERVABILITY_HOST ?? "0.0.0.0",
    observabilityPort: Number(env.WORKER_OBSERVABILITY_PORT ?? 9091),
    solanaDepositReconcileIntervalSeconds: Number(
      env.SOLANA_DEPOSIT_RECONCILE_INTERVAL_SECONDS ?? env.SOLANA_TOPUP_RECONCILE_INTERVAL_SECONDS ?? 15
    ),
    solanaDirectDepositScanIntervalSeconds: Number(env.SOLANA_DIRECT_DEPOSIT_SCAN_INTERVAL_SECONDS ?? 600),
    solanaDirectDepositScanBatchSize: Number(env.SOLANA_DIRECT_DEPOSIT_SCAN_BATCH_SIZE ?? 25),
    billing: {
      currency: env.BILLING_CURRENCY ?? "USD",
      solanaTokenSymbol: env.SOLANA_TOKEN_SYMBOL ?? (nativeSolBilling ? "SOL" : "USDC"),
      solanaTokenMint: env.SOLANA_TOKEN_MINT ?? (nativeSolBilling ? "native" : ""),
      solanaRpcUrl: env.SOLANA_RPC_URL ?? "",
      solanaHistoryRpcUrl: env.SOLANA_HISTORY_RPC_URL ?? env.SOLANA_RPC_URL ?? "",
      solanaHistoryRpcRequestsPerSecond: Number(env.SOLANA_HISTORY_RPC_REQUESTS_PER_SECOND ?? 8),
      solanaTokenBaseUnitsPerBillingMinor: Number(
        env.SOLANA_TOKEN_BASE_UNITS_PER_BILLING_MINOR ?? (nativeSolBilling ? 1 : 10_000)
      ),
      solanaTokenDecimals: Number(env.SOLANA_TOKEN_DECIMALS ?? (nativeSolBilling ? 9 : 6)),
      solanaExplorerTransactionBaseUrl: env.SOLANA_EXPLORER_TX_BASE_URL ?? "https://orbmarkets.io/tx/",
      usageMarkupBps: Number(env.BILLING_USAGE_MARKUP_BPS ?? 1500),
      solanaAssetKind: nativeSolBilling ? "native" : "spl",
      configPriceLamports: Number(env.SOLANA_CONFIG_PRICE_LAMPORTS ?? 100_000),
      configPaymentTreasuryAddress: env.SOLANA_REVENUE_TREASURY_ADDRESS ?? "",
      configPaymentEnabled: env.SOLANA_CONFIG_PAYMENT_ENABLED === "true"
    },
    heliusUsage: {
      projectId: env.HELIUS_PROJECT_ID ?? "",
      intervalSeconds: Number(env.HELIUS_USAGE_POLL_INTERVAL_SECONDS ?? 300),
      adminApiBaseUrl: env.HELIUS_ADMIN_API_BASE_URL ?? "https://admin-api.helius.xyz"
    },
    retailBilling: {
      enabled: env.RETAIL_BILLING_ENABLED === "true",
      mode: env.RETAIL_BILLING_MODE === "enforce" ? "enforce" : "shadow",
      intervalSeconds: Number(env.RETAIL_BILLING_INTERVAL_SECONDS ?? 300),
      settlementLagSeconds: Number(env.RETAIL_BILLING_SETTLEMENT_LAG_SECONDS ?? 120),
      batchSize: Number(env.RETAIL_BILLING_BATCH_SIZE ?? 250)
    },
    billingNotifications: {
      provider: env.EMAIL_PROVIDER === "resend" ? "resend" : "disabled",
      resendApiKey: env.RESEND_API_KEY ?? "",
      from: env.EMAIL_FROM ?? "Hyperspace <no-reply@hyperspace.zone>",
      replyTo: env.EMAIL_REPLY_TO ?? "gatekeepers@hyperspace.zone"
    },
    solanaWithdrawals: {
      enabled: env.SOLANA_WITHDRAWALS_ENABLED === "true",
      intervalSeconds: Number(env.SOLANA_WITHDRAWAL_INTERVAL_SECONDS ?? 30),
      custodialEncryptionKey: env.CUSTODIAL_WALLET_ENCRYPTION_KEY
        ? parseAes256GcmKey(env.CUSTODIAL_WALLET_ENCRYPTION_KEY, "CUSTODIAL_WALLET_ENCRYPTION_KEY")
        : null,
      feePayer: parseSolanaFeePayer(env.SOLANA_FEE_PAYER_SECRET_KEY)
    },
    solanaRevenueSweeps: {
      enabled: env.SOLANA_REVENUE_SWEEPS_ENABLED === "true",
      intervalSeconds: Number(env.SOLANA_REVENUE_SWEEP_INTERVAL_SECONDS ?? 30),
      treasuryAddress: env.SOLANA_REVENUE_TREASURY_ADDRESS ?? ""
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
    ntpDiscoveryMaxCandidates: Number(env.NTP_DISCOVERY_MAX_CANDIDATES ?? 96),
    tradingProbesEnabled: env.TRADING_PROBES_ENABLED === "true"
  };
  validateSolanaPayoutConfig(config);
  return config;
}

function validateSolanaPayoutConfig(config: ControlPlaneWorkerConfig): void {
  if (!config.solanaWithdrawals.enabled && !config.solanaRevenueSweeps.enabled) return;
  if (!config.billing.solanaRpcUrl) {
    throw new Error("SOLANA_RPC_URL is required when Solana withdrawals or revenue sweeps are enabled");
  }
  if (!config.solanaWithdrawals.custodialEncryptionKey) {
    throw new Error("CUSTODIAL_WALLET_ENCRYPTION_KEY is required when Solana withdrawals or revenue sweeps are enabled");
  }
  if (!config.solanaWithdrawals.feePayer) {
    throw new Error("SOLANA_FEE_PAYER_SECRET_KEY is required when Solana withdrawals or revenue sweeps are enabled");
  }
  if (config.solanaRevenueSweeps.enabled) {
    if (!config.solanaRevenueSweeps.treasuryAddress) {
      throw new Error("SOLANA_REVENUE_TREASURY_ADDRESS is required when Solana revenue sweeps are enabled");
    }
    try {
      new PublicKey(config.solanaRevenueSweeps.treasuryAddress);
    } catch {
      throw new Error("SOLANA_REVENUE_TREASURY_ADDRESS must be a valid Solana public key");
    }
  }
}

function parseSolanaFeePayer(value: string | undefined): Keypair | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("SOLANA_FEE_PAYER_SECRET_KEY must be a JSON array of 64 bytes");
  }
  if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error("SOLANA_FEE_PAYER_SECRET_KEY must be a JSON array of 64 bytes");
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
}
