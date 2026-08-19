import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "@hyperspace-zone/db";
import { createHealthRegistry, createRuntimeMetrics } from "@hyperspace-zone/shared";
import {
  collectControlPlaneSnapshotMetrics,
  collectBenchmarkMetrics,
  collectGateAgentDeploymentMetrics,
  gateAgentDeploymentFailureClass,
  gateAlertProbeHost
} from "./control-plane-snapshot.js";

test("snapshot sections continue after one collector fails", async () => {
  const metrics = createRuntimeMetrics({ service: "snapshot-test", flushIntervalMs: 60_000 });
  const health = createHealthRegistry("snapshot-test");
  let laterSectionRan = false;

  await assert.rejects(
    collectControlPlaneSnapshotMetrics({
      db: {} as Database,
      metrics,
      health,
      sections: [
        { name: "broken", collect: async () => { throw new Error("missing relation"); } },
        { name: "healthy", collect: async () => { laterSectionRan = true; } }
      ]
    }),
    /broken: missing relation/
  );

  const rendered = metrics.renderPrometheus();
  metrics.stop();

  assert.equal(laterSectionRan, true);
  assert.match(rendered, /hyperspace_control_plane_snapshot_ready\{service="snapshot-test"\} 0/);
  assert.match(rendered, /hyperspace_control_plane_snapshot_section_ready\{section="broken",service="snapshot-test"\} 0/);
  assert.match(rendered, /hyperspace_control_plane_snapshot_section_ready\{section="healthy",service="snapshot-test"\} 1/);
  assert.match(rendered, /hyperspace_control_plane_snapshot_section_errors_total\{section="broken",service="snapshot-test"\} 1/);
});

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
  } as unknown as Database;
  const metrics = createRuntimeMetrics({ service: "snapshot-test", flushIntervalMs: 60_000 });

  await collectBenchmarkMetrics(db, metrics);
  const rendered = metrics.renderPrometheus();
  metrics.stop();

  assert.equal(queries.length, 1);
  assert.match(queries[0] ?? "", /LIMIT 2/);
  assert.match(rendered, /hyperspace_control_plane_benchmark_gate_confirmed_failed_routes\{gate="gate-a"[^}]*\} 1/);
  assert.match(
    rendered,
    /hyperspace_control_plane_benchmark_route_age_seconds\{[^}]*source_probe_host="gate-a\.example\.test"[^}]*source_public_ipv4="192\.0\.2\.10"[^}]*target_probe_host="gate-b\.example\.test"[^}]*target_public_ipv4="192\.0\.2\.11"[^}]*\}/
  );
  assert.match(rendered, /hyperspace_control_plane_benchmark_routes_total\{service="snapshot-test",status="failed",transport="public"\} 2/);
  assert.match(rendered, /hyperspace_control_plane_benchmark_rtt_p50_ms\{service="snapshot-test",status="failed",transport="public"\} 15/);
});

test("gate-agent deployment snapshot exposes immutable release and gate access labels", async () => {
  const db = {
    async query() {
      return {
        rows: [{
          gate: "gate-eu-lon-01",
          publicIpv4: "192.0.2.10",
          probeUrl: "https://gate-eu-lon-01.example.test/.well-known/hyperspace-probe",
          phase: "verifying",
          releaseVersion: "0.2.2",
          releaseRevision: "a".repeat(40),
          artifactSha256: "b".repeat(64),
          failureCode: null,
          ageSeconds: 700,
          deadlineSecondsUntilExpiry: -400
        }],
        rowCount: 1
      };
    }
  } as unknown as Database;
  const metrics = createRuntimeMetrics({ service: "snapshot-test", flushIntervalMs: 60_000 });

  await collectGateAgentDeploymentMetrics(db, metrics);
  const rendered = metrics.renderPrometheus();
  metrics.stop();

  assert.match(rendered, /hyperspace_control_plane_gate_agent_deployment_latest_status\{[^}]*phase="verifying"[^}]*\} 1/);
  assert.match(rendered, /hyperspace_control_plane_gate_agent_deployment_active_age_seconds\{[^}]*probe_host="gate-eu-lon-01\.example\.test"[^}]*public_ipv4="192\.0\.2\.10"[^}]*\} 700/);
  assert.match(rendered, /artifact_sha256="b{64}"/);
});

test("gate-agent deployment failures distinguish installation from host validation", () => {
  assert.equal(gateAgentDeploymentFailureClass("agent_release_download_failed"), "installation");
  assert.equal(gateAgentDeploymentFailureClass("service_start_failed"), "installation");
  assert.equal(gateAgentDeploymentFailureClass("agent_release_self_test_failed"), "validation");
  assert.equal(gateAgentDeploymentFailureClass("post_install_self_test_failed"), "validation");
  assert.equal(gateAgentDeploymentFailureClass("rollback_timeout"), "other");
});

function benchmarkRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    sourceGate: "gate-a",
    sourcePublicIpv4: "192.0.2.10",
    sourceProbeUrl: "https://gate-a.example.test/.well-known/hyperspace-probe",
    sourceAgentConnected: true,
    targetGate: "gate-b",
    targetPublicIpv4: "192.0.2.11",
    targetProbeUrl: "https://gate-b.example.test/.well-known/hyperspace-probe",
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
