import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerPublicRateLimits, type PublicRateLimitConfig } from "./rate-limit.js";

test("public rate limiter returns 429 with retry headers", async () => {
  const app = Fastify({ logger: false });
  registerPublicRateLimits(app, testConfig({
    readWindowSeconds: 60,
    readMax: 2
  }));
  app.get("/v1/public/gates", async () => ({ ok: true }));

  const first = await app.inject({ method: "GET", url: "/v1/public/gates", remoteAddress: "198.51.100.10" });
  const second = await app.inject({ method: "GET", url: "/v1/public/gates", remoteAddress: "198.51.100.10" });
  const third = await app.inject({ method: "GET", url: "/v1/public/gates", remoteAddress: "198.51.100.10" });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(third.statusCode, 429);
  assert.equal(third.json().error, "rate_limited");
  assert.equal(third.headers["x-ratelimit-limit"], "2");
  assert.equal(third.headers["x-ratelimit-remaining"], "0");
  assert.ok(Number(third.headers["retry-after"]) > 0);

  await app.close();
});

function testConfig(overrides: Partial<PublicRateLimitConfig>): PublicRateLimitConfig {
  return {
    enabled: true,
    readWindowSeconds: 60,
    readMax: 100,
    authWindowSeconds: 60,
    authMax: 100,
    mutationWindowSeconds: 60,
    mutationMax: 100,
    downloadWindowSeconds: 60,
    downloadMax: 100,
    ...overrides
  };
}
