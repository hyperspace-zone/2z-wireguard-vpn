#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { createDatabase } from "../../packages/db/dist/index.js";
import {
  completeGoogleOAuth,
  createGoogleOAuthStart,
  loginUser,
  registerUser,
  requestEmailLoginCode,
  verifyEmailLoginCode
} from "../../packages/control-plane/dist/index.js";

const databaseUrl = process.env.DATABASE_URL || "";
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const runId = `${Date.now()}-${randomBytes(5).toString("hex")}`;
const emailPrefix = `identity-e2e-${runId}`;
const otpHashSecret = randomBytes(32).toString("hex");
const password = `Hs-${randomBytes(18).toString("base64url")}`;
const db = createDatabase({
  connectionString: databaseUrl,
  applicationName: "hyperspace-identity-linking-e2e"
});
const results = [];

try {
  const googleFirstEmail = `${emailPrefix}-google-first@ostealmar.resend.app`;
  const googleFirst = await googleLogin({
    email: googleFirstEmail,
    sub: `${emailPrefix}-google-sub`,
    name: "Google First"
  });
  const googleThenOtp = await otpLogin(googleFirstEmail);
  assertEqual(googleThenOtp.user.accountId, googleFirst.user.accountId, "Google-first then OTP account");
  results.push("google-first-then-otp");

  const verifiedPasswordEmail = `${emailPrefix}-password-verified@ostealmar.resend.app`;
  await passwordRegistration(verifiedPasswordEmail, "Verified Password");
  const verifiedPasswordOtp = await otpLogin(verifiedPasswordEmail);
  const passwordBeforeGoogle = await passwordLogin(verifiedPasswordEmail);
  assertEqual(passwordBeforeGoogle.user.accountId, verifiedPasswordOtp.user.accountId, "verified password account");
  const verifiedPasswordGoogle = await googleLogin({
    email: verifiedPasswordEmail,
    sub: `${emailPrefix}-verified-password-google-sub`,
    name: "Verified Password Google"
  });
  assertEqual(verifiedPasswordGoogle.user.accountId, verifiedPasswordOtp.user.accountId, "verified password then Google account");
  const passwordAfterGoogle = await passwordLogin(verifiedPasswordEmail);
  assertEqual(passwordAfterGoogle.user.accountId, verifiedPasswordOtp.user.accountId, "password preserved after safe Google link");
  results.push("verified-password-then-google");

  const pendingPasswordEmail = `${emailPrefix}-password-pending@ostealmar.resend.app`;
  await passwordRegistration(pendingPasswordEmail, "Pending Password");
  const pendingPasswordGoogle = await googleLogin({
    email: pendingPasswordEmail,
    sub: `${emailPrefix}-pending-password-google-sub`,
    name: "Pending Password Claimed"
  });
  const oldPasswordLogin = await loginUser(db, {
    email: pendingPasswordEmail,
    password,
    authSessionTtlSeconds: 3600
  });
  assertEqual(oldPasswordLogin, "invalid_credentials", "unverified password must be removed during Google claim");
  const claimedOtp = await otpLogin(pendingPasswordEmail);
  assertEqual(claimedOtp.user.accountId, pendingPasswordGoogle.user.accountId, "claimed Google account then OTP");
  results.push("unverified-password-secure-google-claim");

  console.log(JSON.stringify({ ok: true, results }, null, 2));
} finally {
  await db.query(
    `
      DELETE FROM audit_events
      WHERE account_id IN (
        SELECT account_id
        FROM users
        WHERE email::text LIKE $1
      )
    `,
    [`${emailPrefix}%`]
  );
  await db.query(
    `
      DELETE FROM accounts
      WHERE id IN (
        SELECT account_id
        FROM users
        WHERE email::text LIKE $1
      )
    `,
    [`${emailPrefix}%`]
  );
  await db.close();
}

async function passwordRegistration(email, displayName) {
  const result = await registerUser(db, { email, password, displayName });
  if (typeof result === "string") {
    throw new Error(`password registration failed: ${result}`);
  }
  return result;
}

async function passwordLogin(email) {
  const result = await loginUser(db, { email, password, authSessionTtlSeconds: 3600 });
  if (typeof result === "string") {
    throw new Error(`password login failed: ${result}`);
  }
  return result;
}

async function otpLogin(email) {
  let code = "";
  const challenge = await requestEmailLoginCode(db, {
    email,
    codeTtlSeconds: 600,
    hashSecret: otpHashSecret,
    sender: {
      async sendLoginCode(input) {
        code = input.code;
      }
    }
  });
  if (typeof challenge === "string" || !code) {
    throw new Error(`OTP request failed: ${challenge}`);
  }
  const result = await verifyEmailLoginCode(db, {
    email,
    code,
    hashSecret: otpHashSecret,
    authSessionTtlSeconds: 3600
  });
  if (typeof result === "string") {
    throw new Error(`OTP verification failed: ${result}`);
  }
  return result;
}

async function googleLogin(profile) {
  const config = {
    clientId: "identity-e2e-client",
    clientSecret: "identity-e2e-secret",
    redirectUrl: "https://app.testnet.hyperspace.zone/api/v1/public/auth/google/callback",
    appRedirectUrl: "https://app.testnet.hyperspace.zone/",
    stateTtlSeconds: 600,
    authSessionTtlSeconds: 3600
  };
  const start = await createGoogleOAuthStart(db, config, { redirectAfter: "/" });
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Google OAuth state was not generated");
  }
  const result = await completeGoogleOAuth(db, config, {
    code: "fake-google-code",
    state,
    fetchImpl: async (url) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return jsonResponse({ access_token: "fake-google-access-token" });
      }
      if (url.includes("openidconnect.googleapis.com/v1/userinfo")) {
        return jsonResponse({
          sub: profile.sub,
          email: profile.email,
          email_verified: true,
          name: profile.name,
          picture: "https://lh3.googleusercontent.com/identity-e2e"
        });
      }
      return jsonResponse({}, false, 404);
    }
  });
  if (typeof result === "string") {
    throw new Error(`Google login failed: ${result}`);
  }
  if (!result.auth.user.avatarUrl) {
    throw new Error("Google avatar was not synchronized");
  }
  return result.auth;
}

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
