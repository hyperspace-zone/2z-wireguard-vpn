import type { Queryable } from "../db/queryable.js";
import {
  listDeploymentsForReconcile,
  markDeploymentFailed,
  markDeploymentRolledBack,
  markDeploymentSucceeded,
  requestDeploymentRollback,
  retryDeploymentRollback
} from "../resources/gate-agent-deployments/repository.js";

export interface GateAgentDeploymentReconcileResult {
  verified: number;
  rollbackRequested: number;
  rolledBack: number;
  failed: number;
}

export async function reconcileGateAgentDeployments(
  db: Queryable,
  now = new Date()
): Promise<GateAgentDeploymentReconcileResult> {
  const rows = await listDeploymentsForReconcile(db);
  const result = { verified: 0, rollbackRequested: 0, rolledBack: 0, failed: 0 };
  for (const row of rows) {
    const targetObserved = row.observedArtifactSha256 === row.targetArtifactSha256;
    const previousObserved = Boolean(
      row.previousArtifactSha256
      && row.observedArtifactSha256 === row.previousArtifactSha256
    );
    const selfTestPassed = row.observedCapabilities.includes("agent-artifact-self-test:passed");
    const heartbeatAfterStage = Boolean(
      row.lastSeenAt
      && (!row.stagedAt || new Date(row.lastSeenAt).getTime() >= new Date(row.stagedAt).getTime())
    );
    const releaseFailureCode = readReleaseFailureCode(row.observedCapabilities, row.targetArtifactSha256);

    if (
      ["staging", "verifying"].includes(row.phase)
      && targetObserved
      && selfTestPassed
      && heartbeatAfterStage
      && row.agentConnected
    ) {
      await markDeploymentSucceeded(db, row.id, row.observedInstalledAt);
      result.verified += 1;
      continue;
    }

    if (["rollback_requested", "rolling_back"].includes(row.phase) && previousObserved && row.agentConnected) {
      await markDeploymentRolledBack(db, row.id, releaseFailureCode);
      result.rolledBack += 1;
      continue;
    }

    if (
      ["staging", "verifying"].includes(row.phase)
      && previousObserved
      && heartbeatAfterStage
      && row.agentConnected
      && releaseFailureCode
    ) {
      await markDeploymentRolledBack(db, row.id, releaseFailureCode);
      result.rolledBack += 1;
      continue;
    }

    if (new Date(row.verificationDeadlineAt).getTime() > now.getTime()) continue;

    if (row.phase === "queued") {
      await markDeploymentFailed(db, row.id, "deployment_not_claimed", "Gate did not claim the deployment before its deadline");
      result.failed += 1;
      continue;
    }

    if (["staging", "verifying"].includes(row.phase)) {
      if (previousObserved && row.agentConnected) {
        await markDeploymentRolledBack(db, row.id, releaseFailureCode);
        result.rolledBack += 1;
      } else if (row.previousArtifactSha256) {
        const rollback = await requestDeploymentRollback(db, row.id, "system", "deployment_verification_timeout");
        if (rollback === "queued") result.rollbackRequested += 1;
      } else {
        await markDeploymentFailed(db, row.id, "verification_timeout", "Candidate was not verified and no previous artifact exists");
        result.failed += 1;
      }
      continue;
    }

    if (["rollback_requested", "rolling_back"].includes(row.phase)) {
      if (row.previousArtifactSha256 && row.rollbackAttemptCount < 3) {
        if (await retryDeploymentRollback(db, row.id)) {
          continue;
        }
      }
      await markDeploymentFailed(db, row.id, "rollback_timeout", "Previous agent artifact was not observed before rollback deadline");
      result.failed += 1;
    }
  }
  return result;
}

export function readReleaseFailureCode(capabilities: string[], targetArtifactSha256: string): string | null {
  const suffix = `:${targetArtifactSha256}`;
  const capability = capabilities.find((value) => value.startsWith("agent-release-failure:") && value.endsWith(suffix));
  if (!capability) return null;
  const code = capability.slice("agent-release-failure:".length, -suffix.length);
  return /^[a-z0-9_]{1,64}$/.test(code) ? code : null;
}
