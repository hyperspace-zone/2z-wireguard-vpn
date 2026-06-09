import type { Queryable } from "../../db/queryable.js";
import { sha256Hex } from "../../security/tokens.js";
import {
  findActiveAuthSessionUserByTokenHash,
  markAuthSessionSeen,
  type PublicUser
} from "./repository.js";

export async function authenticatePublicAuthSession(
  db: Queryable,
  token: string
): Promise<PublicUser | null> {
  const tokenHash = sha256Hex(token);
  const user = await findActiveAuthSessionUserByTokenHash(db, tokenHash);
  if (!user) {
    return null;
  }

  await markAuthSessionSeen(db, tokenHash);
  return user;
}
