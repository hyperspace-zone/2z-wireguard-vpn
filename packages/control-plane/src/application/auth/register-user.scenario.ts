import type { TransactionalQueryable } from "../../db/queryable.js";
import { insertRegisteredUser, type PublicUser } from "../../resources/users/repository.js";
import { hashPassword } from "../../security/passwords.js";
import { isUniqueViolation } from "../../support/db.js";
import { createAuthSession } from "./auth-session.js";
export type { PublicUser } from "../../resources/users/repository.js";

export interface AuthSessionResult {
  user: PublicUser;
  accessToken: string;
  expiresAt: string;
}

export type RegisterUserError = "invalid_email" | "weak_password" | "email_already_registered";

export async function registerUser(
  db: TransactionalQueryable,
  input: {
    email: string;
    password: string;
    displayName?: string;
    authSessionTtlSeconds: number;
  }
): Promise<AuthSessionResult | RegisterUserError> {
  const email = normalizeEmail(input.email);
  if (!email || !email.includes("@")) {
    return "invalid_email";
  }
  if (!input.password || input.password.length < 12) {
    return "weak_password";
  }

  return db.transaction(async (client) => {
    const createdUser = await insertRegisteredUser(client, {
      email,
      displayName: input.displayName?.trim() || email,
      passwordHash: hashPassword(input.password)
    });
    const session = await createAuthSession(createdUser.id, input.authSessionTtlSeconds, client);
    return { user: createdUser, accessToken: session.token, expiresAt: session.expiresAt };
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) {
      return "email_already_registered";
    }
    throw error;
  });
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
