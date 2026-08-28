import type { TransactionalQueryable } from "../db/queryable.js";
import { deleteExpiredGateActualStateSnapshots } from "../resources/actual-state/repository.js";
import { revokeExpiredArtifactDownloadTokens } from "../resources/artifacts/repository.js";
import { revokeExpiredAuthSessions } from "../resources/users/repository.js";
import { cleanupTradingProbeHistory } from "../resources/trading-probes/service.js";

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
    const tradingProbeCleanup = await cleanupTradingProbeHistory(client);
    return {
      authSessionsRevoked,
      artifactDownloadTokensRevoked,
      gateActualStateSnapshotsDeleted,
      tradingProbeJobsDeleted: tradingProbeCleanup.jobsDeleted,
      tradingProbeRollupsDeleted: tradingProbeCleanup.rollupsDeleted
    };
  });
}
