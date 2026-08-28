import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkRequestTimeoutMs, shouldLoadBenchmarkMatrix } from "./benchmark-isolation.js";

test("only the benchmarks view loads the benchmark matrix", () => {
  assert.equal(shouldLoadBenchmarkMatrix("benchmarks"), true);
  assert.equal(shouldLoadBenchmarkMatrix("dashboard"), false);
  assert.equal(shouldLoadBenchmarkMatrix("create-config"), false);
  assert.equal(shouldLoadBenchmarkMatrix("billing"), false);
  assert.equal(shouldLoadBenchmarkMatrix("login"), false);
  assert.equal(benchmarkRequestTimeoutMs, 10_000);
});
