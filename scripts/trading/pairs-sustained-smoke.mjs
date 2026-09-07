import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";

// Public read-only canary across several worker snapshot cycles. No auth,
// funding, session creation or artificial latency thresholds. Run after rollout.
const results = [];
for (let round = 0; round < 18; round += 1) {
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
      } catch (error) {
        result = { ...context, status: 0, error: error.name };
      }
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
  if (round < 17) await setTimeout(10_000);
}
const failures = results.filter(result => result.status !== 200 || !Number.isInteger(result.rows) || (result.endpoint === "benchmarks" && result.rows === 0));
console.log(JSON.stringify({ summary: true, requests: results.length, failures: failures.length, maxMs: Math.max(...results.map(result => result.ms ?? 0)), readOnly: true }));
assert.deepEqual(failures, []);
