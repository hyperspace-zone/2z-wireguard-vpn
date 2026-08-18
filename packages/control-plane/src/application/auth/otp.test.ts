import assert from "node:assert/strict";
import test from "node:test";
import { generateNumericOtp, hashEmailOtp, verifyHash } from "./otp.js";

test("email OTP hash verifies only the same normalized email and code", () => {
  const secret = "test-secret";
  const email = "otp-hash-unit@vutcenoi.resend.app";
  const otherEmail = "otp-hash-other-unit@vutcenoi.resend.app";
  const code = "482731";
  const hash = hashEmailOtp(secret, email, code);

  assert.equal(verifyHash(hashEmailOtp(secret, email, code), hash), true);
  assert.equal(verifyHash(hashEmailOtp(secret, otherEmail, code), hash), false);
  assert.equal(verifyHash(hashEmailOtp(secret, email, "164208"), hash), false);
});

test("numeric OTP generation returns a six digit code", () => {
  const code = generateNumericOtp();

  assert.match(code, /^\d{6}$/);
});
