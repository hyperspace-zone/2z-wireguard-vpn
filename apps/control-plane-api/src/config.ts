import { defaultSessionAbuseControlConfig } from "@hyperspace-zone/control-plane";
import { defaultEmailSendBudgetConfig } from "@hyperspace-zone/control-plane";
import { readFileSync } from "node:fs";
import { parseAes256GcmKey } from "@hyperspace-zone/shared";
import type { ControlPlaneApiRuntimeConfig } from "./app.js";
import { defaultPublicRateLimitConfig } from "./http/rate-limit.js";

export interface ControlPlaneApiProcessConfig extends ControlPlaneApiRuntimeConfig {
  databaseUrl: string;
  probesDatabaseUrl?: string;
  benchmarkDatabaseMaxConnections: number;
  benchmarkDatabaseStatementTimeoutMs: number;
  host: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControlPlaneApiProcessConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const artifactEncryptionKeyRaw = env.ARTIFACT_ENCRYPTION_KEY;
  const nativeSolBilling = env.SOLANA_ASSET_KIND === "native";
  const turnstileEnabled = readBoolean(env, "TURNSTILE_ENABLED", false);
  const turnstileSecret = turnstileEnabled && env.TURNSTILE_SECRET_KEY_FILE ? readFileSync(env.TURNSTILE_SECRET_KEY_FILE, "utf8").trim() : env.TURNSTILE_SECRET_KEY ?? "";
  const turnstileHosts = (env.TURNSTILE_HOSTNAMES ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (turnstileEnabled && (!env.TURNSTILE_SITE_KEY || !turnstileSecret || !turnstileHosts.length)) throw new Error("Turnstile requires site key, secret and exact hostname allowlist");
  if (env.EMAIL_PROVIDER === "resend" && !env.RESEND_API_KEY) throw new Error("Resend email delivery requires an API key");
  return {
    trustedProxyCidrs: (env.TRUSTED_PROXY_CIDRS ?? "127.0.0.1,::1").split(",").map(value => value.trim()).filter(Boolean),
    emailAuthProtection: {
      turnstile: { enabled: turnstileEnabled, siteKey: env.TURNSTILE_SITE_KEY ?? "", secretKey: turnstileSecret, hostnames: turnstileHosts,
        timeoutMs: readPositiveInteger(env, "TURNSTILE_TIMEOUT_MS", 5000) },
      otpIpMax: readPositiveInteger(env, "EMAIL_OTP_IP_MAX", 5),
      otpIpWindowSeconds: readPositiveInteger(env, "EMAIL_OTP_IP_WINDOW_SECONDS", 900),
      budget: { dailyMax: readPositiveInteger(env, "EMAIL_OTP_DAILY_MAX", defaultEmailSendBudgetConfig.dailyMax),
        intervalMs: readPositiveInteger(env, "EMAIL_OTP_SEND_INTERVAL_MS", defaultEmailSendBudgetConfig.intervalMs),
        cooldownSeconds: readPositiveInteger(env, "EMAIL_OTP_COOLDOWN_SECONDS", defaultEmailSendBudgetConfig.cooldownSeconds),
        emailMax: readPositiveInteger(env, "EMAIL_OTP_EMAIL_MAX", defaultEmailSendBudgetConfig.emailMax),
        emailWindowSeconds: readPositiveInteger(env, "EMAIL_OTP_EMAIL_WINDOW_SECONDS", defaultEmailSendBudgetConfig.emailWindowSeconds) }
    },
    databaseUrl,
    ...(env.PROBES_DATABASE_URL ? { probesDatabaseUrl: env.PROBES_DATABASE_URL } : {}),
    benchmarkDatabaseMaxConnections: readPositiveInteger(env, "BENCHMARK_DATABASE_MAX_CONNECTIONS", 2),
    benchmarkDatabaseStatementTimeoutMs: readPositiveInteger(env, "BENCHMARK_DATABASE_STATEMENT_TIMEOUT_MS", 8_000),
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? "8080"),
    authSessionTtlSeconds: Number(env.AUTH_SESSION_TTL_SECONDS ?? 60 * 60 * 24 * 30),
    downloadTokenTtlSeconds: Number(env.ARTIFACT_DOWNLOAD_TTL_SECONDS ?? 300),
    ...(env.ADMIN_TOKEN ? { adminToken: env.ADMIN_TOKEN } : {}),
    billingAdminEmails: readEmailList(env.BILLING_ADMIN_EMAILS),
    artifactEncryptionKey: artifactEncryptionKeyRaw ? parseAes256GcmKey(artifactEncryptionKeyRaw) : null,
    gateAgentReleaseDir: env.GATE_AGENT_RELEASE_DIR ?? "/var/lib/hyperspace/gate-agent-releases",
    emailAuth: {
      provider: env.EMAIL_PROVIDER === "resend" ? "resend" : "console",
      resendApiKey: env.RESEND_API_KEY ?? "",
      from: env.EMAIL_FROM ?? "Hyperspace <no-reply@hyperspace.zone>",
      replyTo: env.EMAIL_REPLY_TO ?? "support@hyperspace.zone",
      otpHashSecret: env.EMAIL_OTP_HASH_SECRET ?? env.ADMIN_TOKEN ?? env.RESEND_API_KEY ?? env.DATABASE_URL ?? "hyperspace-dev-email-otp",
      otpTtlSeconds: Math.min(1800, readPositiveInteger(env, "EMAIL_OTP_TTL_SECONDS", 10 * 60)),
      exposeCodes: readBoolean(env, "EMAIL_OTP_EXPOSE_CODES", false)
    },
    googleOAuth: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_OAUTH_REDIRECT_URL
      ? {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        redirectUrl: env.GOOGLE_OAUTH_REDIRECT_URL,
        appRedirectUrl: env.APP_PUBLIC_URL ?? env.PUBLIC_APP_URL ?? "https://app.testnet.hyperspace.zone",
        stateTtlSeconds: readPositiveInteger(env, "GOOGLE_OAUTH_STATE_TTL_SECONDS", 10 * 60),
        authSessionTtlSeconds: Number(env.AUTH_SESSION_TTL_SECONDS ?? 60 * 60 * 24 * 30)
      }
      : null,
    walletAuth: {
      custodialEncryptionKey: env.CUSTODIAL_WALLET_ENCRYPTION_KEY
        ? parseAes256GcmKey(env.CUSTODIAL_WALLET_ENCRYPTION_KEY, "CUSTODIAL_WALLET_ENCRYPTION_KEY")
        : null
    },
    billing: {
      currency: env.BILLING_CURRENCY ?? "USD",
      solanaTokenSymbol: env.SOLANA_TOKEN_SYMBOL ?? (nativeSolBilling ? "SOL" : "USDC"),
      solanaTokenMint: env.SOLANA_TOKEN_MINT ?? (nativeSolBilling ? "native" : ""),
      solanaRpcUrl: env.SOLANA_RPC_URL ?? "",
      solanaTokenBaseUnitsPerBillingMinor: readPositiveInteger(
        env,
        "SOLANA_TOKEN_BASE_UNITS_PER_BILLING_MINOR",
        nativeSolBilling ? 1 : 10_000
      ),
      solanaTokenDecimals: readNonNegativeInteger(env, "SOLANA_TOKEN_DECIMALS", nativeSolBilling ? 9 : 6),
      solanaExplorerTransactionBaseUrl: env.SOLANA_EXPLORER_TX_BASE_URL ?? "https://orbmarkets.io/tx/",
      usageMarkupBps: readNonNegativeInteger(env, "BILLING_USAGE_MARKUP_BPS", 1500),
      enforcePositiveBalance: readBoolean(env, "BILLING_ENFORCE_POSITIVE_BALANCE", false),
      requiredMinBalanceMinor: readNonNegativeInteger(env, "BILLING_REQUIRED_MIN_BALANCE_MINOR", 0),
      solanaAssetKind: nativeSolBilling ? "native" : "spl",
      configPriceLamports: readNonNegativeInteger(env, "SOLANA_CONFIG_PRICE_LAMPORTS", 100_000_000),
      configTrafficLimitBytes: readPositiveInteger(env, "SOLANA_CONFIG_TRAFFIC_LIMIT_BYTES", 50_000_000_000),
      configPaymentTreasuryAddress: env.SOLANA_REVENUE_TREASURY_ADDRESS ?? "",
      configPaymentEnabled: readBoolean(env, "SOLANA_CONFIG_PAYMENT_ENABLED", false)
    },
    publicRateLimit: {
      measurementsWindowSeconds: readPositiveInteger(env, "PUBLIC_MEASUREMENTS_WINDOW_SECONDS", 60),
      measurementsMax: readPositiveInteger(env, "PUBLIC_MEASUREMENTS_IP_MAX", 120),
      measurementsGlobalMax: readPositiveInteger(env, "PUBLIC_MEASUREMENTS_GLOBAL_MAX", 600),
      measurementsMaxInFlight: readPositiveInteger(env, "PUBLIC_MEASUREMENTS_MAX_IN_FLIGHT", 8),
      enabled: readBoolean(env, "PUBLIC_RATE_LIMIT_ENABLED", defaultPublicRateLimitConfig.enabled),
      readWindowSeconds: readPositiveInteger(
        env,
        "PUBLIC_RATE_LIMIT_READ_WINDOW_SECONDS",
        defaultPublicRateLimitConfig.readWindowSeconds
      ),
      readMax: readPositiveInteger(env, "PUBLIC_RATE_LIMIT_READ_MAX", defaultPublicRateLimitConfig.readMax),
      authWindowSeconds: readPositiveInteger(
        env,
        "PUBLIC_RATE_LIMIT_AUTH_WINDOW_SECONDS",
        defaultPublicRateLimitConfig.authWindowSeconds
      ),
      authMax: readPositiveInteger(env, "PUBLIC_RATE_LIMIT_AUTH_MAX", defaultPublicRateLimitConfig.authMax),
      mutationWindowSeconds: readPositiveInteger(
        env,
        "PUBLIC_RATE_LIMIT_MUTATION_WINDOW_SECONDS",
        defaultPublicRateLimitConfig.mutationWindowSeconds
      ),
      mutationMax: readPositiveInteger(
        env,
        "PUBLIC_RATE_LIMIT_MUTATION_MAX",
        defaultPublicRateLimitConfig.mutationMax
      ),
      downloadWindowSeconds: readPositiveInteger(
        env,
        "PUBLIC_RATE_LIMIT_DOWNLOAD_WINDOW_SECONDS",
        defaultPublicRateLimitConfig.downloadWindowSeconds
      ),
      downloadMax: readPositiveInteger(
        env,
        "PUBLIC_RATE_LIMIT_DOWNLOAD_MAX",
        defaultPublicRateLimitConfig.downloadMax
      )
    },
    selfServiceAbuseControls: {
      maxActiveSessionsPerAccount: readPositiveInteger(
        env,
        "SELF_SERVICE_MAX_ACTIVE_SESSIONS_PER_ACCOUNT",
        defaultSessionAbuseControlConfig.maxActiveSessionsPerAccount
      ),
      maxSessionCreatesPerWindow: readPositiveInteger(
        env,
        "SELF_SERVICE_MAX_SESSION_CREATES_PER_WINDOW",
        defaultSessionAbuseControlConfig.maxSessionCreatesPerWindow
      ),
      sessionCreateWindowSeconds: readPositiveInteger(
        env,
        "SELF_SERVICE_SESSION_CREATE_WINDOW_SECONDS",
        defaultSessionAbuseControlConfig.sessionCreateWindowSeconds
      ),
      allowPrivateDestinations: readBoolean(
        env,
        "SELF_SERVICE_ALLOW_PRIVATE_DESTINATIONS",
        defaultSessionAbuseControlConfig.allowPrivateDestinations
      )
    }
  };
}

function readNonNegativeInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function readPositiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (!raw) {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function readEmailList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return [...new Set(
    raw
      .split(/[\s,]+/u)
      .map((value) => value.trim().toLowerCase())
      .filter((value) => /^[^@\s]+@[^@\s]+$/u.test(value))
  )];
}
