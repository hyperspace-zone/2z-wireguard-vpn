import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "@hyperspace-zone/db";
import { createHealthRegistry, createRuntimeMetrics } from "@hyperspace-zone/shared";
import { loadConfig } from "../config.js";
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
  const config = loadConfig({
    DATABASE_URL: "postgres://worker-test.invalid/hyperspace",
    ARTIFACT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
    WORKER_POLL_MS: "10",
    BENCHMARK_SCHEDULER_POLL_MS: "10",
    WORKER_SNAPSHOT_INTERVAL_MS: "10",
    WORKER_ID: "worker-test"
  });
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
