import {
  scheduleGateBenchmarkProbes,
  scheduleGateNtpDiscoveryJobs
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";

export interface BenchmarkSchedulerRuntimeConfig {
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

export interface BenchmarkSchedulerLoop {
  runOnce(): Promise<void>;
}

export function createBenchmarkSchedulerLoop(input: {
  db: Database;
  config: BenchmarkSchedulerRuntimeConfig;
}): BenchmarkSchedulerLoop {
  return {
    runOnce: async () => {
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
