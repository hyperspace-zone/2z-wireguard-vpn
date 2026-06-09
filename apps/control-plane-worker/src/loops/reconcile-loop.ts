import {
  beginSessionRevocation,
  completeProvisionedSessions,
  completeRevokedSessions,
  failTimedOutProvisioningSessions,
  markStaleGates,
  reconcileDrift,
  reconcileExpiry,
  enqueueCommitJobsForPreparedAssignments,
  enqueueRevocationJobsForAssignments,
  scheduleRequestedSessions
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import { log } from "../support/runtime.js";

export interface ReconcileLoopRuntimeConfig {
  gateHeartbeatStaleSeconds: number;
  provisioningTimeoutSeconds: number;
  artifactEncryptionKey: Buffer;
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
      await scheduleRequestedSessions(input.db, {
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
    }
  };
}
