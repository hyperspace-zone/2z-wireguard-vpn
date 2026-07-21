import assert from "node:assert/strict";
import test from "node:test";
import { createHealthRegistry, createRuntimeMetrics } from "./observability.js";

test("health registry reports component state independently from metrics", () => {
  const health = createHealthRegistry("test-service");
  health.setComponent("process", { state: "ready" });
  health.setComponent("database", { state: "degraded", message: "slow query" });

  const snapshot = health.snapshot();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.service, "test-service");
  assert.equal(snapshot.state, "degraded");
  assert.equal(snapshot.components.length, 2);
});

test("runtime metrics aggregate raw events into prometheus exposition", () => {
  const metrics = createRuntimeMetrics({ service: "test-service", flushIntervalMs: 60_000 });
  metrics.counter("api_requests_total", 1, { labels: { route: "/health" } });
  metrics.counter("api_requests_total", 2, { labels: { route: "/health" } });
  metrics.gauge("gates_total", 5, { labels: { state: "ready" } });
  metrics.histogram("request_duration_seconds", 0.01, { labels: { route: "/health" }, buckets: [0.01, 0.1] });

  const rendered = metrics.renderPrometheus();
  metrics.stop();

  assert.match(rendered, /# TYPE hyperspace_api_requests_total counter/);
  assert.match(rendered, /hyperspace_api_requests_total\{route="\/health",service="test-service"\} 3/);
  assert.match(rendered, /hyperspace_gates_total\{service="test-service",state="ready"\} 5/);
  assert.match(rendered, /hyperspace_request_duration_seconds_bucket\{route="\/health",service="test-service",le="0.01"\} 1/);
});

test("runtime metrics can replace a dynamic gauge family", () => {
  const metrics = createRuntimeMetrics({ service: "test-service", flushIntervalMs: 60_000 });
  metrics.gauge("gate_ready", 1, { labels: { gate: "old-gate" } });
  metrics.renderPrometheus();

  metrics.resetGauge("gate_ready");
  metrics.gauge("gate_ready", 1, { labels: { gate: "new-gate" } });
  const rendered = metrics.renderPrometheus();
  metrics.stop();

  assert.doesNotMatch(rendered, /old-gate/);
  assert.match(rendered, /hyperspace_gate_ready\{gate="new-gate",service="test-service"\} 1/);
});
