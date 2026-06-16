import { parseAes256GcmKey } from "@hyperspace-zone/shared";
import type { ControlPlaneApiRuntimeConfig } from "./app.js";
import { defaultAbuseControlsConfig, type AbuseControlsConfig, type RateLimitPolicyConfig } from "./http/abuse-controls.js";

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
    abuseControls: loadAbuseControlsConfig(env)
  };
}

function loadAbuseControlsConfig(env: NodeJS.ProcessEnv): AbuseControlsConfig {
  const defaults = defaultAbuseControlsConfig();
  return {
    enabled: parseBoolean(env.ABUSE_CONTROLS_ENABLED, defaults.enabled),
    authRegister: loadPolicy(env, "ABUSE_AUTH_REGISTER", defaults.authRegister),
    authLogin: loadPolicy(env, "ABUSE_AUTH_LOGIN", defaults.authLogin),
    publicMutation: loadPolicy(env, "ABUSE_PUBLIC_MUTATION", defaults.publicMutation),
    artifactDownload: loadPolicy(env, "ABUSE_ARTIFACT_DOWNLOAD", defaults.artifactDownload),
    gate: loadPolicy(env, "ABUSE_GATE", defaults.gate),
    admin: loadPolicy(env, "ABUSE_ADMIN", defaults.admin)
  };
}

function loadPolicy(
  env: NodeJS.ProcessEnv,
  prefix: string,
  defaults: RateLimitPolicyConfig
): RateLimitPolicyConfig {
  return {
    maxRequests: parsePositiveInteger(env[`${prefix}_MAX_REQUESTS`], defaults.maxRequests),
    windowSeconds: parsePositiveInteger(env[`${prefix}_WINDOW_SECONDS`], defaults.windowSeconds)
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
