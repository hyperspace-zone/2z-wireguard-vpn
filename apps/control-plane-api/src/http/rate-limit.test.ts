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

test("rotating Authorization and spoofed forwarding headers cannot reset auth counters", async () => {
  const app = Fastify(); registerPublicRateLimits(app, testConfig({ authMax: 2 }));
  app.post("/v1/public/auth/email/request-code", async () => ({ ok: true }));
  app.post("/v1/public/auth/email/verify-code", async () => ({ ok: true }));
  try {
    for (let i = 0; i < 5; i++) {
      const response = await app.inject({ method: "POST", url: i % 2 ? "/v1/public/auth/email/verify-code" : "/v1/public/auth/email/request-code",
        remoteAddress: "198.51.100.20", headers: { authorization: `Bearer arbitrary-${i}`, "x-forwarded-for": `203.0.113.${i + 1}` } });
      assert.equal(response.statusCode, i < 2 ? 200 : 429);
    }
  } finally { await app.close(); }
});

test("auth limiter does not block gate polling or non-auth public reads", async () => {
  const app = Fastify(); registerPublicRateLimits(app, testConfig({ authMax: 1 }));
  app.post("/v1/public/auth/email/request-code", async () => ({ ok: true }));
  app.get("/v1/public/gates", async () => ({ ok: true }));
  app.post("/v1/gate/heartbeat", async () => ({ ok: true }));
  try {
    await app.inject({ method: "POST", url: "/v1/public/auth/email/request-code" });
    assert.equal((await app.inject({ method: "POST", url: "/v1/public/auth/email/request-code" })).statusCode, 429);
    assert.equal((await app.inject("/v1/public/gates")).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/v1/gate/heartbeat" })).statusCode, 200);
  } finally { await app.close(); }
});

test("public measurement limits have separate IP/global budgets and cannot block operational routes", async () => {
  const app = Fastify(); registerPublicRateLimits(app, testConfig({ measurementsMax: 2, measurementsGlobalMax: 3 }));
  app.get("/v1/public/benchmarks/gate-matrix", async () => ({ ok: true }));
  app.get("/v1/public/trading/latency", async () => ({ ok: true }));
  app.get("/v1/public/billing", async () => ({ ok: true }));
  app.get("/v1/public/trading/routes/:id", async () => ({ ok: true }));
  app.post("/v1/gate/heartbeat", async () => ({ ok: true }));
  app.post("/v1/trading-probe/jobs/claim", async () => ({ ok: true }));
  try {
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({ url: i % 2 ? "/v1/public/trading/latency" : "/v1/public/benchmarks/gate-matrix", remoteAddress: "198.51.100.1" });
      assert.equal(r.statusCode, i < 2 ? 200 : 429);
    }
    assert.equal((await app.inject({ url: "/v1/public/trading/latency", remoteAddress: "198.51.100.2" })).statusCode, 200);
    const overload = await app.inject({ url: "/v1/public/trading/latency", remoteAddress: "198.51.100.3" });
    assert.equal(overload.statusCode, 503); assert.equal(overload.headers["cache-control"], "no-store");
    assert.equal((await app.inject("/v1/public/billing")).statusCode, 200);
    assert.equal((await app.inject("/v1/public/trading/routes/validate-before-purchase")).statusCode, 200);
    for (const url of ["/v1/gate/heartbeat", "/v1/trading-probe/jobs/claim"]) assert.equal((await app.inject({ method: "POST", url })).statusCode, 200);
  } finally { await app.close(); }
});

test("measurement concurrency has no waiting queue and slots release after success and failure", async () => {
  const app = Fastify(); registerPublicRateLimits(app, testConfig({ measurementsMaxInFlight: 1 }));
  let release!: () => void, entered!: () => void;
  const inside = new Promise<void>(r => { entered = r; });
  const blocked = new Promise<void>(r => { release = r; });
  let first = true;
  app.get("/v1/public/trading/latency", async () => { if (first) { first = false; entered(); await blocked; throw new Error("test failure"); } return { ok: true }; });
  app.get("/health", async () => ({ ok: true }));
  try {
    const pending = app.inject("/v1/public/trading/latency");
    await inside;
    assert.equal((await app.inject("/v1/public/trading/latency")).statusCode, 503);
    assert.equal((await app.inject("/health")).statusCode, 200);
    release(); assert.equal((await pending).statusCode, 500);
    assert.equal((await app.inject("/v1/public/trading/latency")).statusCode, 200);
  } finally { release(); await app.close(); }
});
