import type { Queryable } from "../../db/queryable.js";
import { insertAuthSession } from "../../resources/users/repository.js";
import { newSecretToken, sha256Hex } from "../../security/tokens.js";

export async function createAuthSession(
  userId: string,
  ttlSeconds: number,
  db: Queryable
): Promise<{ token: string; expiresAt: string }> {
  const token = newSecretToken();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await insertAuthSession(db, { userId, tokenHash: sha256Hex(token), expiresAt });
  return { token, expiresAt };
}
