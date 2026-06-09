import { createHash, randomBytes } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newSecretToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}
