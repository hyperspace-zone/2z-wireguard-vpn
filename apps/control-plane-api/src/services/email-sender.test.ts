import assert from "node:assert/strict";
import test from "node:test";
import { createEmailSender, EmailDeliveryError } from "./email-sender.js";
const config = { provider: "resend" as const, resendApiKey: "unit-key", from: "sender@example.com", replyTo: "reply@example.com" };
const input = { email: "user@example.com", code: "123456", expiresAt: "2026-10-05T16:00:00Z", idempotencyKey: "challenge-uuid" };
test("sender uses idempotency and bounded timeout", async () => {
  const http = (async (_url, init) => { assert.equal(new Headers(init?.headers).get("Idempotency-Key"), "email-otp/challenge-uuid"); assert.ok(init?.signal); return new Response('{}', { status: 200 }); }) as typeof fetch;
  await createEmailSender(config, undefined, http).sendLoginCode(input);
});
test("provider error bodies are not exposed and retry delays are bounded", async () => {
  for (const [status, reason, seconds] of [[429, "provider_rate_limit", 300], [403, "provider_rejected", 300], [500, "provider_unavailable", 300]] as const) {
    const http = (async () => new Response("secret-email-and-key", { status, headers: { "retry-after": "9999" } })) as typeof fetch;
    await assert.rejects(createEmailSender(config, undefined, http).sendLoginCode(input), error => {
      assert.ok(error instanceof EmailDeliveryError); assert.equal(error.reason, reason); assert.equal(error.retryAfter, seconds); assert.doesNotMatch(error.message, /secret-email-and-key/); return true;
    });
  }
});
test("sender allows only two simultaneous calls and has no growing queue", async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  const http = (async () => { calls++; await held; return new Response('{}'); }) as typeof fetch;
  const sender = createEmailSender(config, undefined, http);
  const first = sender.sendLoginCode(input), second = sender.sendLoginCode(input);
  await assert.rejects(sender.sendLoginCode(input), EmailDeliveryError); assert.equal(calls, 2);
  release(); await Promise.all([first, second]); await sender.sendLoginCode(input); assert.equal(calls, 3);
});
test("console provider neither sends nor logs credentials", async () => {
  let called = false; const http = (async () => { called = true; return new Response(); }) as typeof fetch;
  await createEmailSender({ ...config, provider: "console" }, undefined, http).sendLoginCode(input); assert.equal(called, false);
});
