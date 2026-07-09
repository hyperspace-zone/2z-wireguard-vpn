import assert from "node:assert/strict";
import test from "node:test";
import { generateNumericOtp, hashEmailOtp, verifyHash } from "./otp.js";

test("email OTP hash verifies only the same normalized email and code", () => {
  const secret = "test-secret";
  const hash = hashEmailOtp(secret, "user@example.com", "123456");

  assert.equal(verifyHash(hashEmailOtp(secret, "user@example.com", "123456"), hash), true);
  assert.equal(verifyHash(hashEmailOtp(secret, "other@example.com", "123456"), hash), false);
  assert.equal(verifyHash(hashEmailOtp(secret, "user@example.com", "654321"), hash), false);
});

test("numeric OTP generation returns a six digit code", () => {
  const code = generateNumericOtp();

  assert.match(code, /^\d{6}$/);
});
