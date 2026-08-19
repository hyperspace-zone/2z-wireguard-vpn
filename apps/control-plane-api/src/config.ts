import { defaultSessionAbuseControlConfig } from "@hyperspace-zone/control-plane";
import { parseAes256GcmKey } from "@hyperspace-zone/shared";
import type { ControlPlaneApiRuntimeConfig } from "./app.js";
import { defaultPublicRateLimitConfig } from "./http/rate-limit.js";

export interface ControlPlaneApiProcessConfig extends ControlPlaneApiRuntimeConfig {
  databaseUrl: string;
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
  return {
    databaseUrl,
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? "8080"),
    authSessionTtlSeconds: Number(env.AUTH_SESSION_TTL_SECONDS ?? 60 * 60 * 24 * 30),
    downloadTokenTtlSeconds: Number(env.ARTIFACT_DOWNLOAD_TTL_SECONDS ?? 300),
    ...(env.ADMIN_TOKEN ? { adminToken: env.ADMIN_TOKEN } : {}),
    artifactEncryptionKey: artifactEncryptionKeyRaw ? parseAes256GcmKey(artifactEncryptionKeyRaw) : null,
    gateAgentReleaseDir: env.GATE_AGENT_RELEASE_DIR ?? "/var/lib/hyperspace/gate-agent-releases",
    emailAuth: {
      provider: env.EMAIL_PROVIDER === "resend" ? "resend" : "console",
      resendApiKey: env.RESEND_API_KEY ?? "",
      from: env.EMAIL_FROM ?? "Hyperspace <no-reply@hyperspace.zone>",
      replyTo: env.EMAIL_REPLY_TO ?? "support@hyperspace.zone",
      otpHashSecret: env.EMAIL_OTP_HASH_SECRET ?? env.ADMIN_TOKEN ?? env.RESEND_API_KEY ?? env.DATABASE_URL ?? "hyperspace-dev-email-otp",
      otpTtlSeconds: readPositiveInteger(env, "EMAIL_OTP_TTL_SECONDS", 10 * 60),
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
      solanaArchivalRpcUrl: env.SOLANA_ARCHIVAL_RPC_URL ?? "",
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
      configPriceLamports: readNonNegativeInteger(env, "SOLANA_CONFIG_PRICE_LAMPORTS", 100_000),
      configPaymentTreasuryAddress: env.SOLANA_REVENUE_TREASURY_ADDRESS ?? "",
      configPaymentEnabled: readBoolean(env, "SOLANA_CONFIG_PAYMENT_ENABLED", false)
    },
    publicRateLimit: {
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
