import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeMetrics } from "@hyperspace-zone/shared";
import { loadConfig } from "../config.js";
import { createHeliusUsageLoop, readHeliusApiKey } from "./helius-usage-loop.js";

const baseEnv = {
  DATABASE_URL: "postgres://worker-test.invalid/hyperspace",
  ARTIFACT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
  SOLANA_RPC_URL: "http://private-rpc.invalid",
  SOLANA_HISTORY_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=test-key",
  HELIUS_PROJECT_ID: "918f7c24-95cf-47fc-b48b-690d47d1a1f8"
};

test("Helius usage polling exports exact project credits without exposing the key", async () => {
  const metrics = createRuntimeMetrics({ service: "helius-usage-test", flushIntervalMs: 60_000 });
  let requestUrl = "";
  let requestKey = "";
  const loop = createHeliusUsageLoop(loadConfig(baseEnv), metrics, {
    now: () => 1_800_000_000_000,
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      requestKey = new Headers(init?.headers).get("X-Api-Key") ?? "";
      return new Response(JSON.stringify({
        creditsRemaining: 800_000,
        creditsUsed: 200_000,
        prepaidCreditsRemaining: 0,
        subscriptionDetails: {
          creditsLimit: 1_000_000,
          billingCycle: { start: "2026-08-01", end: "2026-09-01" }
        }
      }));
    }
  });

  assert.equal(loop.due(), true);
  await loop.runOnce();
  const rendered = metrics.renderPrometheus();
  assert.match(requestUrl, /918f7c24-95cf-47fc-b48b-690d47d1a1f8\/usage$/);
  assert.equal(requestKey, "test-key");
  assert.match(rendered, /hyperspace_helius_credits_remaining\{provider="helius",service="helius-usage-test"\} 800000/);
  assert.match(rendered, /hyperspace_helius_usage_poll_ready\{provider="helius",service="helius-usage-test"\} 1/);
  assert.doesNotMatch(rendered, /test-key/);
  metrics.stop();
});

test("Helius usage polling fails closed without leaking an RPC credential", async () => {
  const metrics = createRuntimeMetrics({ service: "helius-usage-test", flushIntervalMs: 60_000 });
  const loop = createHeliusUsageLoop(loadConfig(baseEnv), metrics, {
    fetchImpl: async () => new Response("forbidden", { status: 403 })
  });
  await assert.rejects(loop.runOnce(), /HTTP 403/);
  const rendered = metrics.renderPrometheus();
  assert.match(rendered, /hyperspace_helius_usage_poll_ready\{provider="helius",service="helius-usage-test"\} 0/);
  assert.doesNotMatch(rendered, /test-key/);
  metrics.stop();
});

test("Helius key extraction accepts only Helius RPC URLs", () => {
  assert.equal(readHeliusApiKey(baseEnv.SOLANA_HISTORY_RPC_URL), "test-key");
  assert.equal(readHeliusApiKey("https://example.com/?api-key=test-key"), null);
  assert.equal(readHeliusApiKey("not-a-url"), null);
});
