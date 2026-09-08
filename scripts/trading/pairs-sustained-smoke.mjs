import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";

// Public read-only canary across several worker snapshot cycles. No auth,
// funding, session creation or artificial latency thresholds. Run after rollout.
const results = [];
const rounds = Number(process.env.TRADING_SMOKE_ROUNDS ?? 18);
assert.ok(Number.isInteger(rounds) && rounds >= 2 && rounds <= 360, "Use 2–360 rounds");
const snapshots = new Map();
for (let round = 0; round < rounds; round += 1) {
  for (const base of ["https://app.staging.hyperspace.zone", "https://app.hyperspace.zone"]) {
    for (const path of ["/api/v1/public/benchmarks/gate-matrix", "/api/v1/public/trading/pairs?limit=5"]) {
      const start = performance.now();
      const context = {
        round,
        environment: base.includes("staging") ? "staging" : "production",
        endpoint: path.includes("gate-matrix") ? "benchmarks" : "pairs"
      };
      let result;
      try {
        const response = await fetch(base + path, { signal: AbortSignal.timeout(20_000) });
        const body = await response.json();
        const rows = context.endpoint === "benchmarks" ? body.routes?.length : body.rows?.length;
        result = { ...context, status: response.status, ms: Math.round(performance.now() - start), rows };
        if (context.endpoint === "pairs" && response.ok) {
          result.snapshotStatus = body.snapshotStatus;
          result.snapshotAgeSeconds = body.snapshotAgeSeconds;
          result.safeSnapshot = ["live", "refreshing", "stale"].includes(body.snapshotStatus)
            && Number.isInteger(body.snapshotAgeSeconds) && body.snapshotAgeSeconds <= 120
            && (body.snapshotStatus === "live" || body.rows.every(row => !row.configEligible));
          if (!snapshots.has(base)) snapshots.set(base, new Set());
          snapshots.get(base).add(body.generatedAt);
        }
      } catch (error) {
        result = { ...context, status: 0, error: error.name };
      }
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
  if (round < rounds - 1) await setTimeout(10_000);
}
const failures = results.filter(result => result.status !== 200 || !Number.isInteger(result.rows) || (result.endpoint === "benchmarks" ? result.rows === 0 : !result.safeSnapshot));
const snapshotVersions = Object.fromEntries([...snapshots].map(([base, values]) => [base, values.size]));
console.log(JSON.stringify({ summary: true, requests: results.length, failures: failures.length, maxMs: Math.max(...results.map(result => result.ms ?? 0)), fallbackResponses: results.filter(result => result.snapshotStatus && result.snapshotStatus !== "live").length, snapshotVersions, readOnly: true }));
assert.deepEqual(failures, []);
for (const versions of snapshots.values()) assert.ok(versions.size > 1, "Snapshots must advance, not just serve one cached value");
