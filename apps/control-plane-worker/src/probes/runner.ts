import type { Database } from "@hyperspace-zone/db";
import type { HealthRegistry, RuntimeMetrics } from "@hyperspace-zone/shared";
import { requeueExpiredJobs, measurementStore, deliverMeasurements } from "@hyperspace-zone/control-plane";
import { createBenchmarkSchedulerLoop, type BenchmarkSchedulerRuntimeConfig } from "../loops/benchmark-scheduler-loop.js";
import { createTradingProbeSchedulerLoop } from "../loops/trading-probe-scheduler-loop.js";
import { collectControlPlaneSnapshotMetrics, collectBenchmarkMetrics, collectTradingProbeMetrics } from "../observability/control-plane-snapshot.js";
import { syncProbesCatalog } from "./catalog-sync.js";
import { cleanupProbesHistory } from "./retention.js";
import { sleep } from "../support/runtime.js";

export async function runProbesWorker(input: {
  core: Database; probes: Database; health: HealthRegistry; metrics: RuntimeMetrics;
  config: BenchmarkSchedulerRuntimeConfig & { tradingProbesEnabled: boolean };
  signal: AbortSignal;
}): Promise<void> {
  const benchmark = createBenchmarkSchedulerLoop({ db: input.probes, config: input.config });
  const trading = createTradingProbeSchedulerLoop({ db: input.probes, config: input.config });
  const store = measurementStore(input.probes);
  let initialized = false;
  let statsAt = 0;
  async function loop(name: string, interval: number, task: () => Promise<void>): Promise<void> {
    while (!input.signal.aborted) {
      try {
        await task();
        input.metrics.gauge("probes_worker_loop_ready", 1, { labels: { loop: name } });
        input.metrics.gauge("probes_worker_loop_last_success_timestamp_seconds", Date.now()/1000, { labels: { loop: name } });
        input.health.setComponent(name, { state: "ready" });
      } catch {
        input.metrics.gauge("probes_worker_loop_ready", 0, { labels: { loop: name } });
        input.metrics.counter("probes_worker_errors_total", 1, { labels: { loop: name } });
        input.health.setComponent(name, { state: "degraded", message: "Optional measurement task unavailable; retrying with bounded interval." });
      }
      if (!input.signal.aborted) await sleep(interval, input.signal);
    }
  }
  await Promise.all([
    ...(store ? [loop("mongo-delivery", 1000, async () => {
      const result = await input.probes.query<{ count: number; age: number }>(`SELECT COUNT(*)::int AS count,
        COALESCE(EXTRACT(EPOCH FROM now()-MIN(created_at)),0)::float AS age FROM measurement_delivery_outbox`);
      input.metrics.gauge("measurements_delivery_backlog", result.rows[0]?.count ?? 0);
      input.metrics.gauge("measurements_delivery_oldest_age_seconds", result.rows[0]?.age ?? 0);
      if (!initialized) { await store.initialize(); initialized = true; }
      await deliverMeasurements(input.probes, store, 200);
      if (store.stats && Date.now()-statsAt>30_000) {
        const stats = await store.stats(); statsAt=Date.now();
        input.metrics.gauge("measurements_mongo_data_bytes",stats.dataBytes);
        input.metrics.gauge("measurements_mongo_storage_bytes",stats.storageBytes);
        input.metrics.gauge("measurements_mongo_index_bytes",stats.indexBytes);
      }
    })] : []),
    loop("catalog-sync", 10_000, () => syncProbesCatalog(input.core, input.probes)),
    loop("scheduler", 15_000, async () => { await requeueExpiredJobs(input.probes); await benchmark.runOnce(); await trading.runOnce(); }),
    loop("retention", 30_000, () => cleanupProbesHistory(input.probes)),
    loop("snapshot", 15_000, async () => {
      await collectControlPlaneSnapshotMetrics({ db: input.probes, health: input.health, metrics: input.metrics, sections: [
        { name: "benchmarks", collect: () => collectBenchmarkMetrics(input.probes, input.metrics) },
        { name: "trading-probes", collect: () => collectTradingProbeMetrics(input.probes, input.metrics) }
      ] });
    })
  ]);
}
