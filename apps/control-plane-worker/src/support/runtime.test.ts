import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { sleep } from "./runtime.js";

test("worker intervals remove abort listeners after every completed timer", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  for (let index = 0; index < 1000; index += 1) {
    const waiting = sleep(10, controller.signal);
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    context.mock.timers.tick(10);
    await waiting;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("shutdown cancels all pending intervals and releases their listeners", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const intervals = Array.from({ length: 4 }, () => sleep(60_000, controller.signal));
  assert.equal(getEventListeners(controller.signal, "abort").length, 4);
  controller.abort();
  await Promise.all(intervals);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await sleep(60_000, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("ordinary sleep still waits for its timer without an abort signal", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let completed = false;
  const waiting = sleep(10).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  context.mock.timers.tick(10);
  await waiting;
  assert.equal(completed, true);
});

test("100000 worker intervals do not retain heap until shutdown", { timeout: 20_000 }, () => {
  // Run GC-sensitive assertions in an isolated process with a controlled
  // clock. The old shared-Promise race retains about 30 MiB for this workload.
  const source = `
    import { mock } from 'node:test';
    import { getEventListeners } from 'node:events';
    import { sleep } from ${JSON.stringify(new URL("./runtime.js", import.meta.url).href)};
    mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    async function run(count) {
      for (let index = 0; index < count; index++) {
        const waiting = sleep(10, controller.signal);
        mock.timers.tick(10);
        await waiting;
      }
    }
    const heap = () => { global.gc(); return process.memoryUsage().heapUsed; };
    await run(1000);
    const before = heap();
    await run(100000);
    const after = heap();
    console.log(JSON.stringify({ growth: after - before, listeners: getEventListeners(controller.signal, 'abort').length }));
    controller.abort();
    mock.timers.reset();
  `;
  const child = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 15_000
  });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  const result = JSON.parse(child.stdout.trim()) as { growth: number; listeners: number };
  assert.equal(result.listeners, 0);
  assert.ok(result.growth < 8 * 1024 * 1024, `intervals retained ${result.growth} heap bytes`);
});
