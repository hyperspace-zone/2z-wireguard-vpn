import type { TransactionalQueryable } from "../../db/queryable.js";
import {
  findPublicUserByEmail,
  insertRegisteredUser,
  lockIdentityEmail,
  type PublicUser
} from "../../resources/users/repository.js";
import { hashPassword } from "../../security/passwords.js";
export type { PublicUser } from "../../resources/users/repository.js";

export interface AuthSessionResult {
  user: PublicUser;
  accessToken: string;
  expiresAt: string;
}

export type RegisterUserError = "invalid_email" | "weak_password" | "email_already_registered";

export interface PendingPasswordRegistration {
  email: string;
}

export async function registerUser(
  db: TransactionalQueryable,
  input: {
    email: string;
    password: string;
    displayName?: string;
  }
): Promise<PendingPasswordRegistration | RegisterUserError> {
  const email = normalizeEmail(input.email);
  if (!email || !email.includes("@")) {
    return "invalid_email";
  }
  if (!input.password || input.password.length < 12) {
    return "weak_password";
  }

  return db.transaction(async (client) => {
    await lockIdentityEmail(client, email);
    if (await findPublicUserByEmail(client, email)) {
      return "email_already_registered";
    }
    const createdUser = await insertRegisteredUser(client, {
      email,
      displayName: input.displayName?.trim() || email,
      passwordHash: hashPassword(input.password)
    });
    return { email: createdUser.email };
  });
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
