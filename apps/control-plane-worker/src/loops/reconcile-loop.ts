import {
  advanceProbedSessionsToScheduling,
  beginSessionRevocation,
  beginRequestedSessionProbing,
  completeProvisionedSessions,
  completeRevokedSessions,
  failTimedOutProvisioningSessions,
  markStaleGates,
  reconcileDrift,
  reconcileExpiry,
  enqueueCommitJobsForPreparedAssignments,
  enqueueRevocationJobsForAssignments,
  scheduleGateBenchmarkProbes,
  scheduleGateNtpDiscoveryJobs,
  scheduleSessionsForProvisioning
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import { log } from "../support/runtime.js";

export interface ReconcileLoopRuntimeConfig {
  gateHeartbeatStaleSeconds: number;
  provisioningTimeoutSeconds: number;
  artifactEncryptionKey: Buffer;
  benchmarkProbesEnabled: boolean;
  benchmarkIntervalSeconds: number;
  benchmarkProbePort: number;
  benchmarkProbeCount: number;
  benchmarkProbeIntervalMs: number;
  benchmarkProbeTimeoutMs: number;
  ntpDiscoveryEnabled: boolean;
  ntpDiscoveryIntervalSeconds: number;
  ntpDiscoverySampleSeconds: number;
  ntpDiscoveryMaxCandidates: number;
}

export interface ReconcileLoop {
  reconcileOnce(): Promise<void>;
}

export interface CreateReconcileLoopInput {
  db: Database;
  config: ReconcileLoopRuntimeConfig;
}

export function createReconcileLoop(input: CreateReconcileLoopInput): ReconcileLoop {
  return {
    reconcileOnce: async () => {
      await markStaleGates(input.db, input.config.gateHeartbeatStaleSeconds);
      await beginSessionRevocation(input.db);
      await enqueueRevocationJobsForAssignments(input.db);
      await beginRequestedSessionProbing(input.db);
      await advanceProbedSessionsToScheduling(input.db);
      await scheduleSessionsForProvisioning(input.db, {
        artifactEncryptionKey: input.config.artifactEncryptionKey,
        log
      });
      await enqueueCommitJobsForPreparedAssignments(input.db);
      await completeProvisionedSessions(input.db, {
        artifactEncryptionKey: input.config.artifactEncryptionKey
      });
      await failTimedOutProvisioningSessions(input.db, {
        provisioningTimeoutSeconds: input.config.provisioningTimeoutSeconds
      });
      await completeRevokedSessions(input.db);
      await reconcileExpiry(input.db);
      await reconcileDrift(input.db);
      await scheduleGateBenchmarkProbes(input.db, {
        enabled: input.config.benchmarkProbesEnabled,
        intervalSeconds: input.config.benchmarkIntervalSeconds,
        probePort: input.config.benchmarkProbePort,
        probeCount: input.config.benchmarkProbeCount,
        probeIntervalMs: input.config.benchmarkProbeIntervalMs,
        probeTimeoutMs: input.config.benchmarkProbeTimeoutMs
      });
      await scheduleGateNtpDiscoveryJobs(input.db, {
        enabled: input.config.ntpDiscoveryEnabled,
        intervalSeconds: input.config.ntpDiscoveryIntervalSeconds,
        sampleSeconds: input.config.ntpDiscoverySampleSeconds,
        maxCandidates: input.config.ntpDiscoveryMaxCandidates
      });
    }
  };
}
