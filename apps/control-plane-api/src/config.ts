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
  return {
    databaseUrl,
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? "8080"),
    authSessionTtlSeconds: Number(env.AUTH_SESSION_TTL_SECONDS ?? 60 * 60 * 24 * 30),
    downloadTokenTtlSeconds: Number(env.ARTIFACT_DOWNLOAD_TTL_SECONDS ?? 300),
    ...(env.ADMIN_TOKEN ? { adminToken: env.ADMIN_TOKEN } : {}),
    artifactEncryptionKey: artifactEncryptionKeyRaw ? parseAes256GcmKey(artifactEncryptionKeyRaw) : null,
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
