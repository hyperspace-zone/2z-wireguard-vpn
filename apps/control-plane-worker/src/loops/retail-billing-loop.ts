import { settleRetailBilling, type RetailBillingSettlementResult } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { ControlPlaneWorkerConfig } from "../config.js";

export function createRetailBillingLoop(db: Database, config: ControlPlaneWorkerConfig): {
  due(): boolean;
  runOnce(): Promise<RetailBillingSettlementResult>;
} {
  let nextRunAt = 0;
  return {
    due(): boolean {
      return config.retailBilling.enabled && Date.now() >= nextRunAt;
    },
    async runOnce(): Promise<RetailBillingSettlementResult> {
      nextRunAt = Date.now() + Math.max(60, config.retailBilling.intervalSeconds) * 1000;
      return settleRetailBilling(db, {
        mode: config.retailBilling.mode,
        settlementLagSeconds: config.retailBilling.settlementLagSeconds,
        batchSize: config.retailBilling.batchSize
      });
    }
  };
}
