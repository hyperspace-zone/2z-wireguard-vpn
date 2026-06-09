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

export async function registerUser(
  db: TransactionalQueryable,
  input: {
    email: string;
    password: string;
    displayName: string;
    authSessionTtlSeconds: number;
  }
): Promise<AuthSessionResult | "email_already_registered"> {
  return db.transaction(async (client) => {
    const createdUser = await insertRegisteredUser(client, {
      email: input.email,
      displayName: input.displayName,
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
