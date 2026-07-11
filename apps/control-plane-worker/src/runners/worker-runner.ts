import type { Database } from "@hyperspace-zone/db";
import type { HealthRegistry, RuntimeMetrics } from "@hyperspace-zone/shared";
import type { ControlPlaneWorkerConfig } from "../config.js";
import { createCleanupLoop } from "../loops/cleanup-loop.js";
import { createDoubleZeroMeteringLoop } from "../loops/doublezero-metering-loop.js";
import { collectControlPlaneSnapshotMetrics } from "../observability/control-plane-snapshot.js";
import { createRetryLoop } from "../loops/retry-loop.js";
import { createSolanaTopupLoop } from "../loops/solana-topup-loop.js";
import { createReconcileRunner } from "./reconcile-runner.js";
import { log, sleep } from "../support/runtime.js";

export interface WorkerRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createWorkerRunner(input: {
  db: Database;
  config: ControlPlaneWorkerConfig;
  health: HealthRegistry;
  metrics: RuntimeMetrics;
  onSnapshotReady?: () => void;
}): WorkerRunner {
  const reconcileRunner = createReconcileRunner({
    db: input.db,
    config: input.config
  });
  const retryLoop = createRetryLoop(input.db);
  const cleanupLoop = createCleanupLoop(input.db);
  const solanaTopupLoop = createSolanaTopupLoop(input.db, input.config);
  const doubleZeroMeteringLoop = createDoubleZeroMeteringLoop(input.db, input.config);
  let stopping = false;

  return {
    async start(): Promise<void> {
      log({ event: "worker_started", workerId: input.config.workerId, pollMs: input.config.pollMs });
      input.metrics.gauge("billing_metering_import_enabled", input.config.doubleZeroMetering.url ? 1 : 0, {
        help: "Whether periodic DoubleZero metering import is configured."
      });
      input.health.setComponent("worker-runner", { state: "ready", message: "Worker runner loop started." });
      while (!stopping) {
        await runMeasuredLoop("reconcile", input, () => reconcileRunner.runOnce());
        await runMeasuredLoop("retry", input, () => retryLoop.runOnce());
        await runMeasuredLoop("cleanup", input, () => cleanupLoop.runOnce());
        await runMeasuredLoop("solana-topups", input, () => solanaTopupLoop.runOnce());
        if (doubleZeroMeteringLoop.due()) {
          const metering = await runMeasuredLoop("doublezero-metering", input, () => doubleZeroMeteringLoop.runOnce());
          if (metering) {
            input.metrics.counter("billing_metering_records_total", metering.imported, {
              help: "Total imported DoubleZero metering records.",
              labels: { result: "imported" }
            });
            input.metrics.counter("billing_metering_records_total", metering.duplicates, {
              help: "Total imported DoubleZero metering records.",
              labels: { result: "duplicate" }
            });
            input.metrics.counter("billing_metering_records_total", metering.rejected, {
              help: "Total imported DoubleZero metering records.",
              labels: { result: "rejected" }
            });
          }
        }
        const snapshotReady = await runMeasuredLoop("snapshot", input, () => collectControlPlaneSnapshotMetrics(input));
        if (snapshotReady) {
          input.onSnapshotReady?.();
        }
        if (!stopping) {
          await sleep(input.config.pollMs);
        }
      }
    },
    async stop(): Promise<void> {
      if (stopping) {
        return;
      }
      stopping = true;
      log({ event: "worker_stopping", workerId: input.config.workerId });
      input.health.setComponent("worker-runner", { state: "stopped", message: "Worker runner is stopping." });
      await input.db.close();
    }
  };
}

async function runMeasuredLoop<T>(
  loop: string,
  input: {
    config: ControlPlaneWorkerConfig;
    health: HealthRegistry;
    metrics: RuntimeMetrics;
  },
  fn: () => Promise<T>
): Promise<T | undefined> {
  const started = process.hrtime.bigint();
  try {
    const result = await fn();
    const durationSeconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
    input.metrics.counter("worker_loop_runs_total", 1, {
      help: "Total worker loop executions by loop and status.",
      labels: { loop, status: "success" }
    });
    input.metrics.histogram("worker_loop_duration_seconds", durationSeconds, {
      help: "Worker loop execution duration in seconds.",
      labels: { loop }
    });
    input.metrics.gauge("worker_loop_last_success_timestamp_seconds", Date.now() / 1000, {
      help: "Unix timestamp of the last successful worker loop execution.",
      labels: { loop }
    });
    input.health.setComponent(`${loop}-loop`, {
      state: "ready",
      message: "Loop completed successfully.",
      details: { durationSeconds }
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.metrics.counter("worker_loop_runs_total", 1, {
      help: "Total worker loop executions by loop and status.",
      labels: { loop, status: "error" }
    });
    input.health.setComponent(`${loop}-loop`, {
      state: "degraded",
      message
    });
    log({
      event: "worker_loop_error",
      workerId: input.config.workerId,
      loop,
      error: message
    });
    return undefined;
  }
}
