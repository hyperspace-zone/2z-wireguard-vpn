import { scryptSync, timingSafeEqual } from "node:crypto";
import { newSecretToken } from "./tokens.js";

export function hashPassword(password: string): string {
  const salt = newSecretToken(16);
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }
  const [, salt, stored] = parts;
  if (!salt || !stored) {
    return false;
  }
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(stored, "base64url");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
