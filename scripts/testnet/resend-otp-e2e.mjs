#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { createResendAuthHelper } from "./resend-auth-helper.mjs";

const apiBase = process.env.HS_API_BASE || "https://app.testnet.hyperspace.zone/api";
const resendApiKey = process.env.RESEND_API_KEY || "";
const receivingDomain = process.env.RESEND_RECEIVING_DOMAIN || "ostealmar.resend.app";

if (!resendApiKey) {
  throw new Error("RESEND_API_KEY is required");
}

const runId = `${Date.now()}-${randomBytes(5).toString("hex")}`;
const passwordEmail = `hyperspace-password-${runId}@${receivingDomain}`;
const otpEmail = `hyperspace-otp-${runId}@${receivingDomain}`;
const password = `Hs-${randomBytes(18).toString("base64url")}`;
const resendAuth = createResendAuthHelper({ api, resendApiKey });

const passwordVerification = await assertAuth(
  passwordEmail,
  await resendAuth.registerPassword({ email: passwordEmail, password })
);
const passwordLogin = await api("/v1/public/auth/login", {
  method: "POST",
  body: { email: passwordEmail, password }
});
assertEqual(passwordLogin.user.accountId, passwordVerification.user.accountId, "password and OTP must use one account");

const repeatedPasswordOtp = await assertAuth(passwordEmail, await resendAuth.loginWithOtp(passwordEmail));
assertEqual(repeatedPasswordOtp.user.accountId, passwordVerification.user.accountId, "repeated OTP must not create another password account");

const otpFirst = await assertAuth(otpEmail, await resendAuth.loginWithOtp(otpEmail));
const repeatedOtp = await assertAuth(otpEmail, await resendAuth.loginWithOtp(otpEmail));
assertEqual(repeatedOtp.user.accountId, otpFirst.user.accountId, "OTP-first login must remain on one account");

console.log(JSON.stringify({
  ok: true,
  apiBase,
  receivingDomain,
  flows: {
    passwordThenOtpThenPassword: passwordEmail,
    otpThenOtp: otpEmail
  }
}, null, 2));

async function assertAuth(email, auth) {
  const me = await api("/v1/public/auth/me", {
    method: "GET",
    token: auth.accessToken
  });
  assertEqual(me.user.email, email, "authenticated email must match recipient");
  assertEqual(me.user.accountId, auth.user.accountId, "session must resolve to the verified account");
  return auth;
}

async function api(path, options) {
  const headers = { "content-type": "application/json" };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  const response = await fetch(`${apiBase}${path}`, {
    method: options.method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });
  const payload = await readJson(response);
  const expectedStatus = options.expectedStatus || 200;
  if (response.status !== expectedStatus) {
    throw new Error(`Hyperspace ${path} returned ${response.status}: ${payload.message || payload.error || "request failed"}`);
  }
  return payload;
}

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
