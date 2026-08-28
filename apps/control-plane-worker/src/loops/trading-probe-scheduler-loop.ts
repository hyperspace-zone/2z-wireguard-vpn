import { scheduleTradingProbeJobs } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";

export interface TradingProbeSchedulerRuntimeConfig {
  tradingProbesEnabled: boolean;
}

export function createTradingProbeSchedulerLoop(input: {
  db: Database;
  config: TradingProbeSchedulerRuntimeConfig;
}): { runOnce(): Promise<void> } {
  return {
    runOnce: async () => {
      await scheduleTradingProbeJobs(input.db, input.config.tradingProbesEnabled);
    }
  };
}
