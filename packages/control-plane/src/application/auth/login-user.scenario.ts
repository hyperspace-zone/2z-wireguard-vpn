import type { Queryable } from "../../db/queryable.js";
import { findPasswordCredentialByEmail } from "../../resources/users/repository.js";
import { verifyPassword } from "../../security/passwords.js";
import { createAuthSession } from "./auth-session.js";
import type { AuthSessionResult, PublicUser } from "./register-user.scenario.js";

export type LoginUserError = "credentials_required" | "invalid_credentials" | "email_not_verified";

export async function loginUser(
  db: Queryable,
  input: {
    email: string;
    password: string;
    authSessionTtlSeconds: number;
  }
): Promise<AuthSessionResult | LoginUserError> {
  const email = normalizeEmail(input.email);
  if (!email || !input.password) {
    return "credentials_required";
  }

  const row = await findPasswordCredentialByEmail(db, email);
  if (!row || !verifyPassword(input.password, row.passwordHash)) {
    return "invalid_credentials";
  }
  if (!row.emailVerified) {
    return "email_not_verified";
  }

  const session = await createAuthSession(row.id, input.authSessionTtlSeconds, db);
  return {
    user: {
      id: row.id,
      accountId: row.accountId,
      email: row.email,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl
    },
    accessToken: session.token,
    expiresAt: session.expiresAt
  };
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
