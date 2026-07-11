export type GoogleIdentityLinkMode =
  | "existing_google_identity"
  | "new_account"
  | "verified_email_account"
  | "unverified_passwordless_account"
  | "claim_unverified_password_account";

export function decideGoogleIdentityLink(input: {
  providerIdentityExists: boolean;
  emailAccountExists: boolean;
  emailVerified: boolean;
  passwordConfigured: boolean;
}): GoogleIdentityLinkMode {
  if (input.providerIdentityExists) {
    return "existing_google_identity";
  }
  if (!input.emailAccountExists) {
    return "new_account";
  }
  if (input.emailVerified) {
    return "verified_email_account";
  }
  if (input.passwordConfigured) {
    return "claim_unverified_password_account";
  }
  return "unverified_passwordless_account";
}
