import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export function generateNumericOtp(length = 6): string {
  const upperBound = 10 ** length;
  return String(randomInt(0, upperBound)).padStart(length, "0");
}

export function hmacSha256Hex(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function hashEmailOtp(secret: string, email: string, code: string): string {
  return hmacSha256Hex(secret, `email-otp:v1:${email}:${code}`);
}

export function verifyHash(actualHex: string, expectedHex: string): boolean {
  const actual = Buffer.from(actualHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
