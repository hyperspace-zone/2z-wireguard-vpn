import type { EncryptedJsonPayload } from "@hyperspace-zone/shared";
import { decryptJsonPayload } from "@hyperspace-zone/shared";
import type { Queryable, TransactionalQueryable } from "../../db/queryable.js";
import { newSecretToken, sha256Hex } from "../../security/tokens.js";
import {
  insertArtifactDownloadToken,
  redeemArtifactDownloadTokenRow,
  selectLatestClientConfigArtifactForSession,
  type ArtifactDownloadRow
} from "./repository.js";

export interface ArtifactDownloadToken {
  token: string;
  expiresAt: string;
  downloadUrl: string;
  downloadConfigUrl: string;
}

export interface ArtifactDownloadPayload {
  artifactId: string;
  metadata: unknown;
  payload: Record<string, unknown>;
  payloadType?: string;
  encryptedPayloadRef: string | null;
}

export async function findLatestClientConfigArtifactForSession(
  db: Queryable,
  accountId: string,
  sessionId: string
): Promise<{ id: string } | null> {
  return selectLatestClientConfigArtifactForSession(db, accountId, sessionId);
}

export async function createArtifactDownloadToken(
  db: Queryable,
  artifactId: string,
  subjectUserId: string,
  ttlSeconds: number
): Promise<ArtifactDownloadToken> {
  const token = newSecretToken();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await insertArtifactDownloadToken(db, {
    artifactId,
    subjectUserId,
    tokenHash: sha256Hex(token),
    expiresAt
  });

  return {
    token,
    expiresAt,
    downloadUrl: `/v1/public/artifacts/download/${token}`,
    downloadConfigUrl: `/v1/public/artifacts/download/${token}?format=conf`
  };
}

export async function redeemArtifactDownloadToken(
  db: TransactionalQueryable,
  token: string,
  artifactEncryptionKey: Buffer | null
): Promise<ArtifactDownloadPayload | "not_found" | "encryption_not_configured"> {
  const tokenHash = sha256Hex(token);
  const result = await redeemArtifactDownloadTokenRow(db, tokenHash);

  if (!result) {
    return "not_found";
  }

  const encryptedPayload = encryptedPayloadFromRow(result);
  if (encryptedPayload && !artifactEncryptionKey) {
    return "encryption_not_configured";
  }

  const payload = encryptedPayload && artifactEncryptionKey
    ? decryptJsonPayload<Record<string, unknown>>(encryptedPayload, artifactEncryptionKey)
    : asRecord(result.publicPayload);

  return {
    artifactId: result.artifactId,
    metadata: result.publicPayload,
    payload,
    ...(result.payloadType ? { payloadType: result.payloadType } : {}),
    encryptedPayloadRef: result.encryptedPayloadRef
  };
}

export function attachmentFileName(value: string | undefined, artifactId: string): string {
  const fallback = `hyperspace-${artifactId.slice(0, 8)}.conf`;
  const baseName = value?.split(/[\\/]/).pop()?.trim() || fallback;
  const sanitized = baseName.replace(/[^A-Za-z0-9._-]/g, "-");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    return fallback;
  }
  return sanitized.endsWith(".conf") ? sanitized : `${sanitized}.conf`;
}

function encryptedPayloadFromRow(row: {
  encryptionMethod: string | null;
  nonce: string | null;
  ciphertext: string | null;
  authTag: string | null;
  aad: string | null;
  keyFingerprint: string | null;
}): EncryptedJsonPayload | null {
  if (!row.encryptionMethod || !row.nonce || !row.ciphertext || !row.authTag || !row.aad || !row.keyFingerprint) {
    return null;
  }
  if (row.encryptionMethod !== "aes-256-gcm") {
    throw new Error(`unsupported artifact encryption method ${row.encryptionMethod}`);
  }
  return {
    encryptionMethod: row.encryptionMethod,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    authTag: row.authTag,
    aad: row.aad,
    keyFingerprint: row.keyFingerprint
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
