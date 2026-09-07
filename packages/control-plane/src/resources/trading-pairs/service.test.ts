import assert from "node:assert/strict";
import test from "node:test";
import type { PublicTradingLatencyResponse, PublicGateBenchmarkMatrixResponse } from "@hyperspace-zone/contracts";
import { buildTradingPairsSnapshot, filterTradingPairs } from "./service.js";

const now = Date.parse("2026-09-07T12:00:00Z");
function fixture() {
  const latency: PublicTradingLatencyResponse = {
    generatedAt: new Date(now).toISOString(),
    nodes: ["source", "egress"].map(id => ({ id, gateId: id, name: id, city: id === "source" ? "Frankfurt" : "Tokyo", country: "Test", provider: "Provider", regionCode: "test", latitude: 0, longitude: 0, fresh: true })),
    targets: ["a", "b"].map((id, i) => ({ id, key: id, venueKey: id, category: i === 0 ? "cex" : "hyperliquid", venueType: i === 0 ? "cex" as const : "perpdex" as const, displayName: id.toUpperCase(), product: "Public API", protocol: "http_json" as const, measurement: "cold API", sortOrder: i, revision: 1, intervalSeconds: 60 })),
    measurements: ["source", "egress"].flatMap(nodeId => ["a", "b"].map((targetId, i) => ({ nodeId, targetId, targetRevision: 1, addressFamily: "ipv4" as const, networkProfile: "direct", status: "succeeded" as const, measuredAt: new Date(now - 1000).toISOString(), tcpMs: nodeId === "source" ? 100 + i * 20 : 20 + i * 10, totalP50Ms: 500, totalP95Ms: 600, sampleCount: 3, failureCount: 0 })))
  };
  const matrix: PublicGateBenchmarkMatrixResponse = {
    generatedAt: new Date(now).toISOString(),
    gates: ["source", "egress"].map(id => ({ id, name: `gate-${id}`, desiredState: "Enabled", publicIpv4: "8.8.8.8", ready: true, schedulable: true })),
    routes: [{ sourceGateId: "source", sourceGateName: "gate-source", targetGateId: "egress", targetGateName: "gate-egress", doublezero: { transport: "doublezero", status: "succeeded", measuredAt: new Date(now - 1000).toISOString(), sourceInterface: "doublezero0", lossPercent: 0, rttMs: { p50: 10 } }, public: { transport: "public", status: "succeeded", measuredAt: new Date(now - 1000).toISOString(), rttMs: { p50: 30 } } }]
  };
  return { latency, matrix };
}

test("pairs use TCP estimates from one source and one shared egress, never API p50 sums", () => {
  const { latency, matrix } = fixture();
  const snapshot = buildTradingPairsSnapshot(latency, matrix, now); const row = snapshot.rows[0]!;
  assert.equal(row.directIndexMs, 220); assert.equal(row.estimatedIndexMs, 70); assert.equal(row.savedMs, 150);
  assert.equal(row.legA.estimatedMs, 30); assert.equal(row.legB.estimatedMs, 40);
  assert.equal(row.legA.directApiP50Ms, 500); assert.equal(row.backboneSavedMs, 20);
  assert.equal(row.configEligible, true); assert.equal(row.evidence, "estimated");
  assert.equal(snapshot.summary.verifiedRoutes, 0); assert.equal(snapshot.rows.length, 2);
  assert.equal(snapshot.rows[1]!.configEligible, false, "gate routes are directional");
});

test("stale, offline, failed, incomplete, mismatched and non-finite probes never produce eligible presets", () => {
  const mutations: Array<(data: ReturnType<typeof fixture>) => void> = [
    d => { d.latency.nodes[0]!.fresh = false; },
    d => { d.latency.measurements[0]!.measuredAt = new Date(now - 181000).toISOString(); },
    d => { d.latency.measurements[0]!.measuredAt = new Date(now + 6000).toISOString(); },
    d => { d.latency.measurements[0]!.status = "failed"; d.latency.measurements[0]!.errorCode = "geo_blocked"; },
    d => { d.latency.measurements[0]!.failureCount = 1; },
    d => { d.latency.measurements[0]!.addressFamily = "ipv6"; },
    d => { delete d.latency.measurements[0]!.addressFamily; },
    d => { d.latency.measurements[2]!.addressFamily = "ipv6"; },
    d => { d.latency.measurements[0]!.sampleCount = 1; },
    d => { d.latency.measurements[0]!.tcpMs = NaN; },
    d => { d.latency.measurements[0]!.tcpMs = -1; },
    d => { d.latency.measurements[0]!.targetRevision = 2; },
    d => { d.latency.measurements[0]!.measuredAt = new Date(now - 90000).toISOString(); },
    d => { d.latency.measurements[2]!.failureCount = 1; },
    d => { d.matrix.gates[1]!.schedulable = false; },
    d => { d.matrix.gates[0]!.ready = false; },
    d => { delete d.latency.nodes[0]!.gateId; },
    d => { d.matrix.routes[0]!.doublezero!.lossPercent = 10; },
    d => { d.matrix.routes[0]!.doublezero!.sourceInterface = "eth0"; },
    d => { d.matrix.routes[0]!.doublezero!.measuredAt = new Date(now - 901000).toISOString(); },
    d => { d.matrix.routes[0]!.doublezeroApplicability = { status: "not_applicable", reason: "same_doublezero_metro", metro: "test" }; }
  ];
  for (const mutate of mutations) { const data = fixture(); mutate(data); assert.equal(buildTradingPairsSnapshot(data.latency, data.matrix, now).rows.some(row => row.configEligible), false); }
});

test("a slower leg is retained, not clipped to zero or recommended", () => {
  const { latency, matrix } = fixture(); latency.measurements[3]!.tcpMs = 115;
  const row = buildTradingPairsSnapshot(latency, matrix, now).rows[0]!;
  assert.equal(row.status, "regression"); assert.equal(row.legB.savedMs, -5); assert.equal(row.savedMs, 65); assert.equal(row.configEligible, false);
});

test("zero baseline is unavailable; a slower combined path is explicitly negative", () => {
  const { latency, matrix } = fixture(); matrix.routes[0]!.doublezero!.rttMs!.p50 = 200;
  const snapshot = buildTradingPairsSnapshot(latency, matrix, now);
  assert.equal(snapshot.rows[0]!.status, "no_improvement"); assert.equal(snapshot.rows[0]!.savedMs, -230);
  assert.equal(filterTradingPairs(snapshot, {}).total, 0);
  assert.equal(filterTradingPairs(snapshot, { positive: "false", noRegression: "false", group: "all" }).total, 2);
  latency.measurements[0]!.tcpMs = 0; latency.measurements[1]!.tcpMs = 0;
  assert.equal(buildTradingPairsSnapshot(latency, matrix, now).rows[0]!.status, "unavailable");
});

test("venue pairs are unordered, exclude infrastructure and deduplicate venue endpoints", () => {
  const { latency, matrix } = fixture();
  latency.targets.push({ ...latency.targets[0]!, id: "infra", venueKey: "base", category: "base", venueType: "infrastructure" });
  latency.targets.push({ ...latency.targets[0]!, id: "a-extra" });
  const snapshot = buildTradingPairsSnapshot(latency, matrix, now);
  assert.equal(snapshot.venues.length, 2); assert.equal(snapshot.rows.length, 2);
  assert.equal(filterTradingPairs(snapshot, { a: "b", b: "a", kind: "cex-perpdex" }).total, 1);
  assert.equal(filterTradingPairs(snapshot, { a: "a", b: "a" }).total, 0);
  assert.equal(filterTradingPairs(snapshot, { evidence: "measured" }).total, 0);
  assert.equal(filterTradingPairs(snapshot, { source: "egress" }).total, 0);
  assert.equal(filterTradingPairs(snapshot, { kind: "cex-cex" }).total, 0);
  assert.equal(filterTradingPairs(snapshot, { search: "Frankfurt" }).total, 1);
});

test("preset identity binds the source, shared egress and exact endpoint revisions", () => {
  const { latency, matrix } = fixture(); const original = buildTradingPairsSnapshot(latency, matrix, now).rows[0]!.id;
  latency.targets[0]!.revision = 2;
  latency.measurements.filter(m => m.targetId === "a").forEach(m => { m.targetRevision = 2; });
  const changed = buildTradingPairsSnapshot(latency, matrix, now).rows[0]!.id;
  assert.match(original, /^[a-f0-9]{64}$/); assert.notEqual(original, changed);
});
