import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  defaultAbuseControlsConfig,
  registerAbuseControls,
  type AbuseControlsConfig
} from "./abuse-controls.js";

test("rate limits matching requests and returns retry metadata", async () => {
  const app = Fastify({ logger: false });
  registerAbuseControls(app, testConfig({
    authLogin: { maxRequests: 1, windowSeconds: 60 }
  }));
  app.post("/v1/public/auth/login", async () => ({ ok: true }));

  const first = await app.inject({
    method: "POST",
    url: "/v1/public/auth/login",
    headers: { "x-forwarded-for": "198.51.100.10" }
  });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({
    method: "POST",
    url: "/v1/public/auth/login",
    headers: { "x-forwarded-for": "198.51.100.10" }
  });
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error, "rate_limited");
  assert.equal(second.headers["x-rate-limit-limit"], "1");
  assert.equal(second.headers["x-rate-limit-remaining"], "0");
  assert.ok(second.headers["retry-after"]);

  await app.close();
});

test("can disable abuse controls", async () => {
  const app = Fastify({ logger: false });
  registerAbuseControls(app, testConfig({
    enabled: false,
    authLogin: { maxRequests: 1, windowSeconds: 60 }
  }));
  app.post("/v1/public/auth/login", async () => ({ ok: true }));

  const first = await app.inject({ method: "POST", url: "/v1/public/auth/login" });
  const second = await app.inject({ method: "POST", url: "/v1/public/auth/login" });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  await app.close();
});

test("public mutation buckets are scoped by bearer token", async () => {
  const app = Fastify({ logger: false });
  registerAbuseControls(app, testConfig({
    publicMutation: { maxRequests: 1, windowSeconds: 60 }
  }));
  app.post("/v1/public/sessions", async () => ({ ok: true }));

  const first = await app.inject({
    method: "POST",
    url: "/v1/public/sessions",
    headers: { authorization: "Bearer token-a" }
  });
  const second = await app.inject({
    method: "POST",
    url: "/v1/public/sessions",
    headers: { authorization: "Bearer token-a" }
  });
  const third = await app.inject({
    method: "POST",
    url: "/v1/public/sessions",
    headers: { authorization: "Bearer token-b" }
  });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 429);
  assert.equal(third.statusCode, 200);
  await app.close();
});

function testConfig(overrides: Partial<AbuseControlsConfig>): AbuseControlsConfig {
  return {
    ...defaultAbuseControlsConfig(),
    ...overrides
  };
}
