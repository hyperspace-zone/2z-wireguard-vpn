import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "@hyperspace-zone/db";
import { createRuntimeMetrics } from "@hyperspace-zone/shared";
import { collectBenchmarkMetrics, gateAlertProbeHost } from "./control-plane-snapshot.js";

test("gate alert probe host comes from explicit probe URL host", () => {
  assert.equal(
    gateAlertProbeHost("https://gate-na-chi-02.hyperspace.zone/.well-known/hyperspace-probe", "152.44.43.130"),
    "gate-na-chi-02.hyperspace.zone"
  );
});

test("gate alert probe host supports IP-address probe URLs", () => {
  assert.equal(
    gateAlertProbeHost("https://203.0.113.20/.well-known/hyperspace-probe", "203.0.113.20"),
    "203.0.113.20"
  );
});

test("gate alert probe host falls back to public IPv4 when probe URL is missing or invalid", () => {
  assert.equal(gateAlertProbeHost(null, "203.0.113.20"), "203.0.113.20");
  assert.equal(gateAlertProbeHost("not-a-url", "203.0.113.20"), "203.0.113.20");
});

test("benchmark snapshot uses one route query and derives aggregate metrics in memory", async () => {
  const queries: string[] = [];
  const db = {
    async query(sql: string) {
      queries.push(sql);
      return {
        rows: [
          benchmarkRow({
            targetGate: "gate-b",
            transport: "public",
            status: "failed",
            sampleCount: 2,
            failedSampleCount: 2,
            rttP50Ms: "10",
            jitterMs: "2",
            lossPercent: "100",
            ageSeconds: 1
          }),
          benchmarkRow({
            targetGate: "gate-b",
            transport: "doublezero",
            status: "succeeded",
            sampleCount: 2,
            failedSampleCount: 0,
            rttP50Ms: "5",
            jitterMs: "1",
            lossPercent: "0",
            ageSeconds: 2
          }),
          benchmarkRow({
            targetGate: "gate-c",
            transport: "public",
            status: "failed",
            sampleCount: 1,
            failedSampleCount: 1,
            rttP50Ms: "20",
            jitterMs: "4",
            lossPercent: "100",
            ageSeconds: 3
          })
        ],
        rowCount: 3
      };
    }
  } as Database;
  const metrics = createRuntimeMetrics({ service: "snapshot-test", flushIntervalMs: 60_000 });

  await collectBenchmarkMetrics(db, metrics);
  const rendered = metrics.renderPrometheus();
  metrics.stop();

  assert.equal(queries.length, 1);
  assert.match(queries[0] ?? "", /LIMIT 2/);
  assert.match(rendered, /hyperspace_control_plane_benchmark_gate_confirmed_failed_routes\{gate="gate-a"[^}]*\} 1/);
  assert.match(rendered, /hyperspace_control_plane_benchmark_routes_total\{service="snapshot-test",status="failed",transport="public"\} 2/);
  assert.match(rendered, /hyperspace_control_plane_benchmark_rtt_p50_ms\{service="snapshot-test",status="failed",transport="public"\} 15/);
});

function benchmarkRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    sourceGate: "gate-a",
    sourcePublicIpv4: "192.0.2.10",
    sourceProbeUrl: "https://gate-a.example.test/.well-known/hyperspace-probe",
    sourceAgentConnected: true,
    targetGate: "gate-b",
    targetAgentConnected: true,
    transport: "public",
    status: "succeeded",
    sampleCount: 2,
    failedSampleCount: 0,
    rttP50Ms: "10",
    jitterMs: "2",
    lossPercent: "0",
    ageSeconds: 1,
    ...overrides
  };
}
