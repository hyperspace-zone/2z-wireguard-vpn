import type { TransactionalQueryable } from "../db/queryable.js";
import { deleteExpiredGateActualStateSnapshots } from "../resources/actual-state/repository.js";
import { revokeExpiredArtifactDownloadTokens } from "../resources/artifacts/repository.js";
import { revokeExpiredAuthSessions } from "../resources/users/repository.js";

export interface CleanupResult {
  authSessionsRevoked: number;
  artifactDownloadTokensRevoked: number;
  gateActualStateSnapshotsDeleted: number;
  tradingProbeJobsDeleted: number;
  tradingProbeRollupsDeleted: number;
}

export async function runCleanupTasks(db: TransactionalQueryable): Promise<CleanupResult> {
  return db.transaction(async (client) => {
    const authSessionsRevoked = await revokeExpiredAuthSessions(client);
    const artifactDownloadTokensRevoked = await revokeExpiredArtifactDownloadTokens(client);
    const gateActualStateSnapshotsDeleted = await deleteExpiredGateActualStateSnapshots(client);
    return {
      authSessionsRevoked,
      artifactDownloadTokensRevoked,
      gateActualStateSnapshotsDeleted,
      // History is deleted only by the DB-host NFS archiver after its files,
      // row counts and checksums have been verified. The worker must not race
      // that fail-closed process.
      tradingProbeJobsDeleted: 0,
      tradingProbeRollupsDeleted: 0
    };
  });
}
