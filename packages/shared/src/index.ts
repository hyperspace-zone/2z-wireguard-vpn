import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes
} from "node:crypto";

export type ResourceConditionStatus = "True" | "False" | "Unknown";

export interface ResourceCondition {
  type: string;
  status: ResourceConditionStatus;
  reason: string;
  message?: string;
  observedGeneration?: number;
  lastTransitionAt: string;
}

export interface ResourceMetadata {
  id: string;
  generation: number;
  createdAt: string;
  updatedAt: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export interface WireGuardKeyPair {
  privateKey: string;
  publicKey: string;
  fingerprint: string;
}

export interface EncryptedJsonPayload {
  encryptionMethod: "aes-256-gcm";
  nonce: string;
  ciphertext: string;
  authTag: string;
  aad: string;
  keyFingerprint: string;
}

const x25519Pkcs8Prefix = Buffer.from("302e020100300506032b656e04220420", "hex");

export function generateWireGuardKeyPair(): WireGuardKeyPair {
  const privateKeyBytes = randomBytes(32);
  const privateKey = privateKeyBytes.toString("base64");
  const privateKeyObject = createPrivateKey({
    key: Buffer.concat([x25519Pkcs8Prefix, privateKeyBytes]),
    format: "der",
    type: "pkcs8"
  });
  const publicKeyBytes = createPublicKey(privateKeyObject)
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const publicKey = publicKeyBytes.toString("base64");
  return {
    privateKey,
    publicKey,
    fingerprint: fingerprintWireGuardKey(publicKey)
  };
}

export function fingerprintWireGuardKey(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 32);
}

export function parseAes256GcmKey(raw: string, name = "ARTIFACT_ENCRYPTION_KEY"): Buffer {
  const value = raw.trim();
  const candidates = [
    /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : null,
    decodeBase64(value),
    decodeBase64Url(value)
  ].filter((candidate): candidate is Buffer => Boolean(candidate));

  const key = candidates.find((candidate) => candidate.length === 32);
  if (!key) {
    throw new Error(`${name} must decode to exactly 32 bytes`);
  }
  return key;
}

export function encryptionKeyFingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export function encryptJsonPayload(value: unknown, key: Buffer, aad: string): EncryptedJsonPayload {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), "utf8")),
    cipher.final()
  ]);
  return {
    encryptionMethod: "aes-256-gcm",
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    aad,
    keyFingerprint: encryptionKeyFingerprint(key)
  };
}

export function decryptJsonPayload<T = unknown>(payload: EncryptedJsonPayload, key: Buffer): T {
  if (payload.encryptionMethod !== "aes-256-gcm") {
    throw new Error(`unsupported encryption method ${payload.encryptionMethod}`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.nonce, "base64url"));
  decipher.setAAD(Buffer.from(payload.aad));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64url")),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

function decodeBase64(value: string): Buffer | null {
  try {
    return Buffer.from(value, "base64");
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): Buffer | null {
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return null;
  }
}
