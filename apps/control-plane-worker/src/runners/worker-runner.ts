import type { Database } from "@hyperspace-zone/db";
import type { ControlPlaneWorkerConfig } from "../config.js";
import { createCleanupLoop } from "../loops/cleanup-loop.js";
import { createRetryLoop } from "../loops/retry-loop.js";
import { createReconcileRunner } from "./reconcile-runner.js";
import { log, sleep } from "../support/runtime.js";

export interface WorkerRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createWorkerRunner(input: {
  db: Database;
  config: ControlPlaneWorkerConfig;
}): WorkerRunner {
  const reconcileRunner = createReconcileRunner({
    db: input.db,
    config: input.config
  });
  const retryLoop = createRetryLoop();
  const cleanupLoop = createCleanupLoop();
  let stopping = false;

  return {
    async start(): Promise<void> {
      log({ event: "worker_started", workerId: input.config.workerId, pollMs: input.config.pollMs });
      while (!stopping) {
        try {
          await reconcileRunner.runOnce();
          await retryLoop.runOnce();
          await cleanupLoop.runOnce();
        } catch (error) {
          log({
            event: "worker_reconcile_error",
            workerId: input.config.workerId,
            error: error instanceof Error ? error.message : String(error)
          });
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
      await input.db.close();
    }
  };
}
