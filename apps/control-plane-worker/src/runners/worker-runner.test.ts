import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import type { Database } from "@hyperspace-zone/db";
import { createHealthRegistry, createRuntimeMetrics } from "@hyperspace-zone/shared";
import { loadConfig } from "../config.js";
import { createWorkerRunner } from "./worker-runner.js";

test("separated core worker never starts synthetic schedulers", async () => {
  let coreCycles=0;
  let probeCycles=0;
  const db={close:async()=>undefined} as Database;
  const config=loadConfig({DATABASE_URL:"postgres://core.invalid/hyperspace",ARTIFACT_ENCRYPTION_KEY:Buffer.alloc(32,7).toString("base64url"),PROBES_SEPARATED:"true",WORKER_POLL_MS:"10"});
  const metrics=createRuntimeMetrics({service:"isolated-core-test"});
  const runner=createWorkerRunner({db,config,metrics,health:createHealthRegistry("isolated-core-test"),tasks:{
    reconcile:async()=>{coreCycles++;},retry:async()=>undefined,cleanup:async()=>undefined,gateAgentDeployments:async()=>undefined,
    benchmarkScheduler:async()=>{probeCycles++;throw new Error("probes down");},
    tradingProbeScheduler:async()=>{probeCycles++;throw new Error("probes down");},snapshot:async()=>true
  }});
  const running=runner.start();
  try { await setImmediate(); assert.ok(coreCycles>0); assert.equal(probeCycles,0); }
  finally {await runner.stop();await running;await metrics.stop();}
});

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
  let benchmarkSchedulerRuns = 0;
  let tradingProbeSchedulerRuns = 0;
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
      gateAgentDeployments: async () => undefined,
      benchmarkScheduler: async () => {
        benchmarkSchedulerRuns += 1;
      },
      tradingProbeScheduler: async () => {
        tradingProbeSchedulerRuns += 1;
      },
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
  assert.ok(benchmarkSchedulerRuns > 0);
  assert.ok(tradingProbeSchedulerRuns > 0);
});

test("stop interrupts all long intervals without repeating work and waits for database close", { timeout: 2000 }, async () => {
  let databaseCloseCalls = 0;
  let releaseDatabaseClose: () => void = () => undefined;
  const closing = new Promise<void>((resolve) => { releaseDatabaseClose = resolve; });
  const runs = { reconcile: 0, benchmark: 0, trading: 0, snapshot: 0 };
  const db = { close: async () => { databaseCloseCalls += 1; await closing; } } as Database;
  const config = loadConfig({
    DATABASE_URL: "postgres://worker-test.invalid/hyperspace",
    ARTIFACT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
    WORKER_POLL_MS: "60000",
    BENCHMARK_SCHEDULER_POLL_MS: "60000",
    TRADING_PROBE_SCHEDULER_POLL_MS: "60000",
    WORKER_SNAPSHOT_INTERVAL_MS: "60000",
    WORKER_ID: "worker-stop-test"
  });
  const metrics = createRuntimeMetrics({ service: "worker-stop-test" });
  const runner = createWorkerRunner({
    db, config, metrics,
    health: createHealthRegistry("worker-stop-test"),
    tasks: {
      reconcile: async () => { runs.reconcile += 1; },
      retry: async () => undefined,
      cleanup: async () => undefined,
      gateAgentDeployments: async () => undefined,
      benchmarkScheduler: async () => { runs.benchmark += 1; },
      tradingProbeScheduler: async () => { runs.trading += 1; },
      snapshot: async () => { runs.snapshot += 1; return true; }
    }
  });
  const running = runner.start();
  try {
    await setImmediate();
    assert.deepEqual(runs, { reconcile: 1, benchmark: 1, trading: 1, snapshot: 1 });
    let stopped = false;
    const stopping = runner.stop().then(() => { stopped = true; });
    const repeatedStop = runner.stop();
    await setImmediate();
    assert.equal(databaseCloseCalls, 1);
    assert.equal(stopped, false);
    releaseDatabaseClose();
    await Promise.all([stopping, repeatedStop, running]);
    assert.equal(stopped, true);
    assert.deepEqual(runs, { reconcile: 1, benchmark: 1, trading: 1, snapshot: 1 });
  } finally {
    releaseDatabaseClose();
    await runner.stop();
    await metrics.stop();
  }
});

test("30000 worker cycles do not accumulate shared shutdown Promise reactions", { timeout: 20_000 }, () => {
  const source = `
    import { mock } from 'node:test';
    import { setImmediate } from 'node:timers/promises';
    import { createHealthRegistry } from '@hyperspace-zone/shared';
    import { createWorkerRunner } from ${JSON.stringify(new URL("./worker-runner.js", import.meta.url).href)};
    import { loadConfig } from ${JSON.stringify(new URL("../config.js", import.meta.url).href)};
    mock.timers.enable({ apis: ['setTimeout'] });
    let cycles = 0;
    const config = loadConfig({
      DATABASE_URL: 'postgres://worker-test.invalid/hyperspace',
      ARTIFACT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
      WORKER_POLL_MS: '1', BENCHMARK_SCHEDULER_POLL_MS: '1',
      TRADING_PROBE_SCHEDULER_POLL_MS: '1', WORKER_SNAPSHOT_INTERVAL_MS: '1',
      WORKER_ID: 'worker-memory-regression'
    });
    const noop = async () => undefined;
    const runner = createWorkerRunner({
      db: { close: noop }, config,
      health: createHealthRegistry('worker-memory-regression'),
      metrics: { gauge() {}, counter() {}, histogram() {} },
      tasks: {
        reconcile: async () => { cycles++; }, retry: noop, cleanup: noop,
        gateAgentDeployments: noop, benchmarkScheduler: noop,
        tradingProbeScheduler: noop, snapshot: async () => true
      }
    });
    const running = runner.start();
    await setImmediate();
    async function run(count) {
      for (let index = 0; index < count; index++) {
        mock.timers.tick(1);
        await setImmediate();
      }
    }
    const heap = () => { global.gc(); return process.memoryUsage().heapUsed; };
    await run(1000);
    const before = heap();
    await run(30000);
    const after = heap();
    await runner.stop();
    await running;
    mock.timers.reset();
    console.log(JSON.stringify({ growth: after - before, cycles }));
  `;
  const child = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 15_000
  });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  const result = JSON.parse(child.stdout.trim().split("\n").at(-1)!) as { growth: number; cycles: number };
  assert.ok(result.cycles >= 30_000, `only ${result.cycles} worker cycles ran`);
  assert.ok(result.growth < 8 * 1024 * 1024, `worker retained ${result.growth} heap bytes`);
});
