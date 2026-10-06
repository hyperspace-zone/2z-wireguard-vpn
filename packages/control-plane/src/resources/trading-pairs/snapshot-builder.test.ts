import assert from "node:assert/strict";
import test from "node:test";
import type { PublicTradingLatencyResponse, PublicGateBenchmarkMatrixResponse } from "@hyperspace-zone/contracts";
import { createSnapshotBuilder, decodeSnapshotParts } from "./snapshot-builder.js";
import { buildTradingPairsSnapshot } from "./service.js";

test("background worker matches the pure snapshot and leaves the HTTP event loop available", async () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const latency: PublicTradingLatencyResponse = {
    generatedAt: new Date(now).toISOString(),
    nodes: [], measurements: [], targets: []
  };
  const matrix: PublicGateBenchmarkMatrixResponse = { generatedAt: new Date(now).toISOString(), gates: [], routes: [] };
  const builder = createSnapshotBuilder();
  try {
    let completed = false;
    const pending = builder.build(latency, matrix, now).then(result => { completed = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(completed, false, "the main event loop must run before CPU work finishes in the worker");
    assert.deepEqual(await pending, buildTradingPairsSnapshot(latency, matrix, now));
    assert.deepEqual(await builder.build(latency, matrix, now), buildTradingPairsSnapshot(latency, matrix, now));
  } finally { await builder.close(); }
  await assert.rejects(builder.build(latency, matrix), /closed/);
});

test("large snapshot delivery yields, preserves row order, and cancels without publishing partial data", async () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;
  const rows = Array.from({ length: 4096 }, (_, i) => ({ id: String(i), reason: "fixture ".repeat(80) }));
  const chunks = Array.from({ length: 64 }, (_, i) => encode(rows.slice(i * 64, (i + 1) * 64)));
  let finished = false;
  const result = decodeSnapshotParts(encode({ summary: { combinations: rows.length } }), chunks).then(value => { finished = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false, "I/O must get a turn before the large result is fully decoded");
  assert.deepEqual((await result).rows, rows);
  await assert.rejects(decodeSnapshotParts(encode({}), chunks, () => false), /cancelled/);
  await assert.rejects(decodeSnapshotParts(encode({}), [encode("not rows")]), /invalid/);
});

test("multi-chunk worker snapshots preserve the pure calculator's fields and eligibility", async () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const latency: PublicTradingLatencyResponse = {
    generatedAt: new Date(now).toISOString(),
    nodes: [{ id: "source", name: "Source", city: "Test", country: "Test", provider: "Provider", regionCode: "test", latitude: 0, longitude: 0, fresh: false }],
    targets: Array.from({ length: 17 }, (_, i) => ({ id: String(i), key: String(i), venueKey: String(i), category: "cex", venueType: "cex", displayName: String(i), product: "Public API", protocol: "http_json", measurement: "TCP", sortOrder: i, revision: 1, intervalSeconds: 60 })),
    measurements: []
  };
  const matrix: PublicGateBenchmarkMatrixResponse = { generatedAt: new Date(now).toISOString(), gates: [], routes: [] };
  const builder = createSnapshotBuilder();
  try {
    const result = await builder.build(latency, matrix, now);
    assert.equal(result.rows.length, 136);
    assert.deepEqual(result, buildTradingPairsSnapshot(latency, matrix, now));
    assert.equal(result.rows.some(row => row.configEligible), false);
  } finally { await builder.close(); }
});
