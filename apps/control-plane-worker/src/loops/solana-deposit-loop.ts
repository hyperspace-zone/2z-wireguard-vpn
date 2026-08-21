import { reconcileDirectSolanaDeposits } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { ControlPlaneWorkerConfig } from "../config.js";

export function createSolanaDepositLoop(db: Database, config: ControlPlaneWorkerConfig): { runOnce(): Promise<void> } {
  let nextRunAt = 0;
  return {
    async runOnce(): Promise<void> {
      if (!config.billing.solanaRpcUrl || Date.now() < nextRunAt) return;
      nextRunAt = Date.now() + Math.max(5, config.solanaDepositReconcileIntervalSeconds) * 1000;
      await reconcileDirectSolanaDeposits(db, config.billing, {
        batchSize: config.solanaDirectDepositScanBatchSize,
        scanIntervalSeconds: config.solanaDirectDepositScanIntervalSeconds
      });
    }
  };
}
