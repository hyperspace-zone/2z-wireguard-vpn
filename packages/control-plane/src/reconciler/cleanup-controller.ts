import type { TransactionalQueryable } from "../db/queryable.js";
import { revokeExpiredArtifactDownloadTokens } from "../resources/artifacts/repository.js";
import { revokeExpiredAuthSessions } from "../resources/users/repository.js";

export interface CleanupResult {
  authSessionsRevoked: number;
  artifactDownloadTokensRevoked: number;
}

export async function runCleanupTasks(db: TransactionalQueryable): Promise<CleanupResult> {
  return db.transaction(async (client) => {
    const authSessionsRevoked = await revokeExpiredAuthSessions(client);
    const artifactDownloadTokensRevoked = await revokeExpiredArtifactDownloadTokens(client);
    return {
      authSessionsRevoked,
      artifactDownloadTokensRevoked
    };
  });
}
