import assert from "node:assert/strict";
import test from "node:test";
import { decideGoogleIdentityLink } from "./identity-linking.policy.js";

test("Google sub remains authoritative when the provider identity already exists", () => {
  assert.equal(decideGoogleIdentityLink({
    providerIdentityExists: true,
    emailAccountExists: true,
    emailVerified: false,
    passwordConfigured: true
  }), "existing_google_identity");
});

test("verified email links Google to the existing password or OTP account", () => {
  assert.equal(decideGoogleIdentityLink({
    providerIdentityExists: false,
    emailAccountExists: true,
    emailVerified: true,
    passwordConfigured: true
  }), "verified_email_account");
});

test("unverified password account is securely claimed instead of preserving an attacker password", () => {
  assert.equal(decideGoogleIdentityLink({
    providerIdentityExists: false,
    emailAccountExists: true,
    emailVerified: false,
    passwordConfigured: true
  }), "claim_unverified_password_account");
});

test("Google creates an account only when neither provider subject nor email exists", () => {
  assert.equal(decideGoogleIdentityLink({
    providerIdentityExists: false,
    emailAccountExists: false,
    emailVerified: false,
    passwordConfigured: false
  }), "new_account");
});
