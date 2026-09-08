import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "@hyperspace-zone/db";
import { createHealthRegistry, createRuntimeMetrics } from "@hyperspace-zone/shared";
import { createSyntheticWriteGuard } from "./synthetic-write-guard.js";

function testGuard(size: string | Error) {
  let queries = 0;
  const db = {
    query: async () => {
      queries += 1;
      if (size instanceof Error) throw size;
      return { rows: [{ size_bytes: size }] };
    }
  } as unknown as Database;
  const health = createHealthRegistry("synthetic-write-guard-test");
  const metrics = createRuntimeMetrics({ service: "synthetic-write-guard-test", flushIntervalMs: 60_000 });
  const guard = createSyntheticWriteGuard({ db, health, metrics, hardLimitBytes: 100, refreshMs: 60_000 });
  return { guard, health, metrics, queries: () => queries };
}

test("synthetic writes remain enabled below the database safety limit and size checks are cached", async () => {
  const fixture = testGuard("99");
  assert.equal(await fixture.guard.allowsWrites(), true);
  assert.equal(await fixture.guard.allowsWrites(), true);
  assert.equal(fixture.queries(), 1);
  assert.match(fixture.metrics.renderPrometheus(), /synthetic_writes_allowed\{service="synthetic-write-guard-test"\} 1/);
  fixture.metrics.stop();
});

test("synthetic writes stop at the database safety limit", async () => {
  const fixture = testGuard("100");
  assert.equal(await fixture.guard.allowsWrites(), false);
  assert.equal(fixture.health.snapshot().state, "degraded");
  fixture.metrics.stop();
});

test("synthetic writes fail closed when database size cannot be checked", async () => {
  const fixture = testGuard(new Error("database unavailable"));
  assert.equal(await fixture.guard.allowsWrites(), false);
  assert.match(fixture.health.snapshot().components[0]?.message ?? "", /could not be verified/);
  fixture.metrics.stop();
});
