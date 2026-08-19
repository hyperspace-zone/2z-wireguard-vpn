import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "@hyperspace-zone/db";
import { createHealthRegistry, createRuntimeMetrics } from "@hyperspace-zone/shared";
import type { ControlPlaneWorkerConfig } from "../config.js";
import { createWorkerRunner } from "./worker-runner.js";

test("snapshot collection runs independently from a slow reconcile cycle", async () => {
  let releaseReconcile: () => void = () => undefined;
  const reconcileBlocked = new Promise<void>((resolve) => {
    releaseReconcile = resolve;
  });
  let snapshotRan: () => void = () => undefined;
  const firstSnapshot = new Promise<void>((resolve) => {
    snapshotRan = resolve;
  });
  let databaseClosed = false;
  const db = {
    close: async () => {
      databaseClosed = true;
    }
  } as Database;
  const config = {
    pollMs: 10,
    benchmarkSchedulerPollMs: 10,
    snapshotIntervalMs: 10,
    workerId: "worker-test"
  } as ControlPlaneWorkerConfig;
  const metrics = createRuntimeMetrics({ service: "worker-runner-test" });
  const runner = createWorkerRunner({
    db,
    config,
    health: createHealthRegistry("worker-runner-test"),
    metrics,
    tasks: {
      reconcile: () => reconcileBlocked,
      retry: async () => undefined,
      cleanup: async () => undefined,
      gateAgentDeployments: async () => undefined,
      benchmarkScheduler: async () => undefined,
      snapshot: async () => {
        snapshotRan();
        return true;
      }
    }
  });

  const running = runner.start();
  await Promise.race([
    firstSnapshot,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("snapshot was blocked by reconcile")), 250))
  ]);

  releaseReconcile();
  await runner.stop();
  await running;
  await metrics.stop();
  assert.equal(databaseClosed, true);
});
