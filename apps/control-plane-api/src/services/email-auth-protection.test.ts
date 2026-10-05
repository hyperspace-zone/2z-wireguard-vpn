import assert from "node:assert/strict";
import test from "node:test";
import { verifyTurnstile, type TurnstileConfig } from "./email-auth-protection.js";

const config: TurnstileConfig = { enabled: true, siteKey: "unit-site", secretKey: "unit-secret", hostnames: ["app.hyperspace.zone"], timeoutMs: 50 };
function response(value: object, status = 200): typeof fetch { return (async () => new Response(JSON.stringify(value), { status })) as typeof fetch; }
test("Turnstile requires success, exact hostname and expected action", async () => {
  assert.equal(await verifyTurnstile(config, "token", "198.51.100.1", "email_otp", response({ success: true, hostname: "app.hyperspace.zone", action: "email_otp" })), "verified");
  for (const value of [{ success: false }, { success: true, hostname: "hyperspace.zone", action: "email_otp" },
    { success: true, hostname: "app.hyperspace.zone.attacker.test", action: "email_otp" }, { success: true, hostname: "app.hyperspace.zone", action: "register" }]) {
    assert.equal(await verifyTurnstile(config, "token", "198.51.100.1", "email_otp", response(value)), "rejected");
  }
});
test("missing/oversized tokens never call Cloudflare", async () => {
  let called = false; const http = (async () => { called = true; return new Response(); }) as typeof fetch;
  assert.equal(await verifyTurnstile(config, "", "ip", "email_otp", http), "rejected");
  assert.equal(await verifyTurnstile(config, "x".repeat(2049), "ip", "email_otp", http), "rejected");
  assert.equal(called, false);
});
test("network failures, provider errors and malformed JSON fail closed", async () => {
  for (const http of [response({}, 503), response({ success: false, "error-codes": ["invalid-input-secret"] }), response({ success: false, "error-codes": ["internal-error"] }), (async () => { throw new Error("network"); }) as typeof fetch,
    (async () => new Response("invalid json")) as typeof fetch]) {
    assert.equal(await verifyTurnstile(config, "token", "ip", "register", http), "unavailable");
  }
});
test("server sends source IP and secret with an abort deadline; development-disabled mode is explicit", async () => {
  let calls = 0;
  const http = (async (_url, init) => { calls++; const body = JSON.parse(String(init?.body)); assert.deepEqual(body, { secret: "unit-secret", response: "token", remoteip: "198.51.100.1" }); assert.ok(init?.signal); return new Response(JSON.stringify({ success: true, hostname: "app.hyperspace.zone", action: "register" })); }) as typeof fetch;
  assert.equal(await verifyTurnstile(config, "token", "198.51.100.1", "register", http), "verified");
  assert.equal(await verifyTurnstile({ ...config, enabled: false }, "", "ip", "register", http), "verified"); assert.equal(calls, 1);
});
