import type { Queryable } from "../../db/queryable.js";
import { findPasswordCredentialByEmail } from "../../resources/users/repository.js";
import { verifyPassword } from "../../security/passwords.js";
import { createAuthSession } from "./auth-session.js";
import type { AuthSessionResult, PublicUser } from "./register-user.scenario.js";

export async function loginUser(
  db: Queryable,
  input: {
    email: string;
    password: string;
    authSessionTtlSeconds: number;
  }
): Promise<AuthSessionResult | "invalid_credentials"> {
  const row = await findPasswordCredentialByEmail(db, input.email);
  if (!row || !verifyPassword(input.password, row.passwordHash)) {
    return "invalid_credentials";
  }

  const session = await createAuthSession(row.id, input.authSessionTtlSeconds, db);
  return {
    user: {
      id: row.id,
      accountId: row.accountId,
      email: row.email,
      displayName: row.displayName
    },
    accessToken: session.token,
    expiresAt: session.expiresAt
  };
}
