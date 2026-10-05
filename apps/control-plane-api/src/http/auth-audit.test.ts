import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import Fastify from "fastify";
import { emailAuditHash, registerAuthAudit } from "./auth-audit.js";

test("audit logs verified source and HMAC recipient without credentials, email, OTP or query values", async () => {
  const lines: string[] = [];
  const sink = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
  const app = Fastify({ logger: { stream: sink }, disableRequestLogging: true });
  registerAuthAudit(app, "unit-hmac-secret");
  app.post("/v1/public/auth/email/request-code", async () => ({ ok: true }));
  for (let i = 0; i < 20; i++) await app.inject({ method: "POST", url: "/v1/public/auth/email/request-code?code=private-query-code", remoteAddress: "198.51.100.50",
    headers: { authorization: "Bearer private-auth-token", cookie: "session=private-cookie" }, payload: { email: "private-recipient@example.com", code: "654321", turnstileToken: "private-turnstile-token" } });
  await app.close();
  const entries = lines.join("").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entries.filter(entry => entry.event === "auth_security_request").length, 1);
  assert.equal(entries.find(entry => entry.event === "auth_security_summary")?.additional_requests, 19);
  assert.equal(entries[0].client_ip, "198.51.100.50");
  assert.equal(entries[0].email_hash, emailAuditHash("private-recipient@example.com", "unit-hmac-secret"));
  assert.doesNotMatch(lines.join(""), /private-recipient|654321|private-query-code|private-auth-token|private-cookie|private-turnstile-token/);
});
test("email hashes are canonical and keyed", () => {
  assert.equal(emailAuditHash(" USER@EXAMPLE.COM ", "key"), emailAuditHash("user@example.com", "key"));
  assert.notEqual(emailAuditHash("user@example.com", "key"), emailAuditHash("user@example.com", "other"));
});
