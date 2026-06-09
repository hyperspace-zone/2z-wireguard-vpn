import { parseAes256GcmKey } from "@hyperspace-zone/shared";
import type { ControlPlaneApiRuntimeConfig } from "./app.js";

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
    artifactEncryptionKey: artifactEncryptionKeyRaw ? parseAes256GcmKey(artifactEncryptionKeyRaw) : null
  };
}
