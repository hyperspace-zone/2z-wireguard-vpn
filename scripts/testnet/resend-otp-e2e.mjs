#!/usr/bin/env node
import { randomBytes } from "node:crypto";

const apiBase = process.env.HS_API_BASE || "https://app.testnet.hyperspace.zone/api";
const resendApiKey = process.env.RESEND_API_KEY || "";
const receivingDomain = process.env.RESEND_RECEIVING_DOMAIN || "ostealmar.resend.app";
const timeoutMs = Number(process.env.RESEND_RECEIVING_TIMEOUT_MS || 90_000);

if (!resendApiKey) {
  throw new Error("RESEND_API_KEY is required");
}

const runId = `${Date.now()}-${randomBytes(5).toString("hex")}`;
const passwordEmail = `hyperspace-password-${runId}@${receivingDomain}`;
const otpEmail = `hyperspace-otp-${runId}@${receivingDomain}`;
const password = `Hs-${randomBytes(18).toString("base64url")}`;
const seenEmailIds = new Set();

const registration = await api("/v1/public/auth/register", {
  method: "POST",
  body: { email: passwordEmail, password },
  expectedStatus: 201
});
assertEqual(registration.status, "sent", "password registration must request verification");

const passwordCode = await waitForOtp(passwordEmail, seenEmailIds);
const passwordVerification = await verifyOtp(passwordEmail, passwordCode);
const passwordLogin = await api("/v1/public/auth/login", {
  method: "POST",
  body: { email: passwordEmail, password }
});
assertEqual(passwordLogin.user.accountId, passwordVerification.user.accountId, "password and OTP must use one account");

await api("/v1/public/auth/email/request-code", {
  method: "POST",
  body: { email: passwordEmail }
});
const repeatedPasswordCode = await waitForOtp(passwordEmail, seenEmailIds);
const repeatedPasswordOtp = await verifyOtp(passwordEmail, repeatedPasswordCode);
assertEqual(repeatedPasswordOtp.user.accountId, passwordVerification.user.accountId, "repeated OTP must not create another password account");

await api("/v1/public/auth/email/request-code", {
  method: "POST",
  body: { email: otpEmail }
});
const otpCode = await waitForOtp(otpEmail, seenEmailIds);
const otpFirst = await verifyOtp(otpEmail, otpCode);
await api("/v1/public/auth/email/request-code", {
  method: "POST",
  body: { email: otpEmail }
});
const repeatedOtpCode = await waitForOtp(otpEmail, seenEmailIds);
const repeatedOtp = await verifyOtp(otpEmail, repeatedOtpCode);
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

async function verifyOtp(email, code) {
  const auth = await api("/v1/public/auth/email/verify-code", {
    method: "POST",
    body: { email, code }
  });
  const me = await api("/v1/public/auth/me", {
    method: "GET",
    token: auth.accessToken
  });
  assertEqual(me.user.email, email, "authenticated email must match recipient");
  assertEqual(me.user.accountId, auth.user.accountId, "session must resolve to the verified account");
  return auth;
}

async function waitForOtp(recipient, seenIds) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await resend("/emails/receiving");
    const email = (list.data || []).find((candidate) =>
      !seenIds.has(candidate.id) &&
      Array.isArray(candidate.to) &&
      candidate.to.some((address) => address.toLowerCase() === recipient.toLowerCase()) &&
      candidate.subject === "Your Hyperspace sign-in code"
    );
    if (email) {
      seenIds.add(email.id);
      const content = await resend(`/emails/receiving/${encodeURIComponent(email.id)}`);
      const match = String(content.text || "").match(/sign-in code is\s+(\d{6})/i);
      if (!match) {
        throw new Error(`OTP was not found in received email ${email.id}`);
      }
      return match[1];
    }
    await delay(2000);
  }
  throw new Error(`Timed out waiting for OTP sent to ${recipient}`);
}

async function resend(path) {
  const response = await fetch(`https://api.resend.com${path}`, {
    headers: { authorization: `Bearer ${resendApiKey}` }
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(`Resend ${path} returned ${response.status}: ${payload.message || payload.name || "request failed"}`);
  }
  return payload;
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
