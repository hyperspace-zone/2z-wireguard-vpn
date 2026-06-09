import type { Database } from "@hyperspace-zone/db";
import type { ControlPlaneWorkerConfig } from "../config.js";
import { createReconcileLoop } from "../loops/reconcile-loop.js";

export interface ReconcileRunner {
  runOnce(): Promise<void>;
}

export function createReconcileRunner(input: {
  db: Database;
  config: ControlPlaneWorkerConfig;
}): ReconcileRunner {
  const loop = createReconcileLoop({
    db: input.db,
    config: input.config
  });
  return {
    runOnce: () => loop.reconcileOnce()
  };
}
