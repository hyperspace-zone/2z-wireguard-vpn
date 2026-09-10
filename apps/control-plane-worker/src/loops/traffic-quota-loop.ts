import {
  enforceSessionTrafficQuotas,
  type TrafficQuotaEnforcementResult
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { ControlPlaneWorkerConfig } from "../config.js";

export function createTrafficQuotaLoop(db: Database, config: ControlPlaneWorkerConfig): {
  due(): boolean;
  runOnce(): Promise<TrafficQuotaEnforcementResult>;
} {
  let nextRunAt = 0;
  return {
    due(): boolean {
      return config.trafficQuotas.enabled && Date.now() >= nextRunAt;
    },
    async runOnce(): Promise<TrafficQuotaEnforcementResult> {
      nextRunAt = Date.now() + Math.max(10, config.trafficQuotas.intervalSeconds) * 1000;
      return enforceSessionTrafficQuotas(db, config.trafficQuotas.batchSize);
    }
  };
}
