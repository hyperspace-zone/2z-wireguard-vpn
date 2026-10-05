import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { createDatabase, type Database } from "@hyperspace-zone/db";
import { reserveEmailSend, readEmailSendBudget, pauseEmailSending, requestEmailLoginCode, verifyEmailLoginCode } from "@hyperspace-zone/control-plane";
import { registerPublicAuthRoutes } from "../surfaces/public/auth.routes.js";
import { loadConfig } from "../config.js";

// Opt-in. All writes are confined to a random disposable schema; no production rows,
// no real Cloudflare validation and no actual emails are used by this suite.
test("email auth PostgreSQL and HTTP integration", { skip: process.env.EMAIL_AUTH_INTEGRATION_TEST !== "1" }, async t => {
  const schema = `test_email_auth_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^test_email_auth_[0-9a-f]{32}$/);
  const admin = createDatabase({ connectionString: process.env.DATABASE_URL!, applicationName: "hs-email-test-admin", maxConnections: 1 });
  let db: Database | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("options", `-c search_path=${schema},public`);
    db = createDatabase({ connectionString: url.toString(), applicationName: "hs-email-antispam-tests", maxConnections: 5 });
    const database = db;
    await database.query(await readFile(new URL("../../../../packages/db/migrations/0052_email_auth_send_limits.sql", import.meta.url), "utf8"));
    const tables = ["accounts", "users", "identities", "auth_sessions", "password_credentials", "audit_events", "email_login_challenges"];
    for (const table of tables) await database.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    const clear = () => database.query(`TRUNCATE ${["email_auth_send_limits", ...tables].map(table => `${schema}.${table}`).join(",")}`);
    const budget = { dailyMax: 7, intervalMs: 0, emailWindowSeconds: 900, emailMax: 3, cooldownSeconds: 0 };

    await t.test("concurrent requests cannot overspend quota; state survives new connections", async () => {
      await clear();
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => reserveEmailSend(database, `recipient-${i}`, budget)));
      assert.equal(results.filter(result => result.allowed).length, 7);
      assert.equal((await readEmailSendBudget(database)).used, 7);
      const second = createDatabase({ connectionString: url.toString(), applicationName: "hs-email-test-restart", maxConnections: 1 });
      try { assert.equal((await readEmailSendBudget(second)).used, 7); assert.deepEqual((await reserveEmailSend(second, "new", budget)).allowed, false); }
      finally { await second.close(); }
      assert.equal((await database.query("SELECT count(*)::int AS count FROM email_auth_send_limits")).rows[0]!.count, 8);
    });
    await t.test("recipient cooldown, window cap and global pacing are independent", async () => {
      await clear(); assert.equal((await reserveEmailSend(database, "a", { ...budget, cooldownSeconds: 60 })).allowed, true);
      assert.equal((await reserveEmailSend(database, "a", { ...budget, cooldownSeconds: 60 }) as { reason: string }).reason, "email_cooldown");
      await clear(); for (let i = 0; i < 3; i++) assert.equal((await reserveEmailSend(database, "a", budget)).allowed, true);
      assert.equal((await reserveEmailSend(database, "a", budget) as { reason: string }).reason, "email_limit");
      await clear(); await reserveEmailSend(database, "a", { ...budget, intervalMs: 1000 });
      assert.equal((await reserveEmailSend(database, "b", { ...budget, intervalMs: 1000 }) as { reason: string }).reason, "send_pacing");
      assert.equal((await readEmailSendBudget(database)).used, 1);
    });
    await t.test("UTC day/window renewal and provider backoff survive restart", async () => {
      await clear(); await reserveEmailSend(database, "a", budget); await pauseEmailSending(database, 60);
      assert.equal((await reserveEmailSend(database, "b", budget) as { reason: string }).reason, "provider_backoff");
      await database.query("UPDATE email_auth_send_limits SET window_start = window_start - interval '1 day', send_count = 999, last_attempt_at = now() - interval '2 days', blocked_until = NULL");
      assert.equal((await reserveEmailSend(database, "a", budget)).allowed, true); assert.equal((await readEmailSendBudget(database)).used, 1);
    });

    const requestCode = (email: string, fails = false) => requestEmailLoginCode(database, { email, codeTtlSeconds: 600, hashSecret: "unit-secret", exposeCode: true,
      sender: { async sendLoginCode() { if (fails) throw new Error("unit delivery failure"); } },
      requestInfo: { sourceIp: "198.51.100.10", requestId: "unit-request", turnstileVerified: true } });
    const verify = (email: string, code: string) => verifyEmailLoginCode(database, { email, code, hashSecret: "unit-secret", authSessionTtlSeconds: 3600 });
    await t.test("resend preserves guessing counter and expiry, failed delivery preserves the previous code", async () => {
      await clear(); const email = "otp-test@example.com";
      const first = await requestCode(email); assert.notEqual(typeof first, "string"); if (typeof first === "string") throw new Error(first);
      const wrong = first.devCode === "000000" ? "111111" : "000000";
      assert.equal(await verify(email, wrong), "invalid_code");
      const second = await requestCode(email); if (typeof second === "string") throw new Error(second);
      assert.equal(new Date(second.expiresAt).getTime(), new Date(first.expiresAt).getTime());
      assert.equal((await database.query("SELECT attempt_count FROM email_login_challenges ORDER BY created_at DESC LIMIT 1")).rows[0]!.attempt_count, 1);
      await assert.rejects(requestCode(email, true), /unit delivery failure/);
      assert.equal((await database.query("SELECT metadata->>'delivery_status' AS state, consumed_at IS NOT NULL AS consumed FROM email_login_challenges ORDER BY created_at DESC LIMIT 1")).rows[0]!.consumed, true);
      const result = await verify(email, second.devCode!); assert.equal(typeof result, "object");
      assert.equal(await verify(email, second.devCode!), "invalid_code"); assert.equal(await verify(email, first.devCode!), "invalid_code");
      const metadata = (await database.query("SELECT metadata FROM email_login_challenges ORDER BY created_at LIMIT 1")).rows[0]!.metadata;
      assert.equal(metadata.source_ip, "198.51.100.10"); assert.equal(metadata.request_id, "unit-request"); assert.equal(metadata.turnstile_verified, true);
    });
    await t.test("five wrong attempts cannot be reset by requesting another code", async () => {
      await clear(); const first = await requestCode("locked@example.com"); if (typeof first === "string") throw new Error(first);
      const wrong = first.devCode === "000000" ? "111111" : "000000";
      for (let i = 0; i < 5; i++) assert.equal(await verify("locked@example.com", wrong), "invalid_code");
      assert.equal(await requestCode("locked@example.com"), "too_many_attempts");
      assert.equal(await verify("locked@example.com", first.devCode!), "too_many_attempts");
      assert.equal((await database.query("SELECT count(*)::int AS count FROM email_login_challenges")).rows[0]!.count, 1);
    });

    await t.test("HTTP rejects missing/invalid/replayed tokens before account, challenge or quota writes", async () => {
      await clear(); let validations = 0; let used = false;
      t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
        validations++; const payload = JSON.parse(String(init.body)); const valid = payload.response === "valid-token" && !used; if (valid) used = true;
        return new Response(JSON.stringify({ success: valid, hostname: "app.hyperspace.zone", action: "email_otp" }));
      });
      const config = loadConfig({ DATABASE_URL: url.toString(), TURNSTILE_ENABLED: "true", TURNSTILE_SITE_KEY: "unit-site", TURNSTILE_SECRET_KEY: "unit-secret", TURNSTILE_HOSTNAMES: "app.hyperspace.zone" });
      const app = Fastify(); registerPublicAuthRoutes(app, { db: database, protection: config.emailAuthProtection, emailAuth: { ...config.emailAuth, exposeCodes: true },
        authSessionTtlSeconds: 3600, googleOAuth: null, requireUser: async () => null, hasBillingAdminAccess: async () => false });
      try {
        const payload = { email: "http-test@example.com" };
        assert.equal((await app.inject({ method: "POST", url: "/v1/public/auth/email/request-code", payload })).statusCode, 403);
        assert.equal(validations, 0);
        assert.equal((await app.inject({ method: "POST", url: "/v1/public/auth/register", payload: { ...payload, password: "unit-password-long" } })).statusCode, 403);
        assert.equal((await database.query("SELECT count(*)::int AS count FROM users")).rows[0]!.count, 0);
        assert.equal((await app.inject({ method: "POST", url: "/v1/public/auth/email/request-code", payload: { ...payload, turnstileToken: "bad" } })).statusCode, 403);
        assert.equal((await database.query("SELECT count(*)::int AS count FROM email_login_challenges")).rows[0]!.count, 0);
        assert.equal((await readEmailSendBudget(database)).used, 0);
        const sent = await app.inject({ method: "POST", url: "/v1/public/auth/email/request-code", payload: { ...payload, turnstileToken: "valid-token" } });
        assert.equal(sent.statusCode, 200, sent.body);
        assert.equal((await app.inject({ method: "POST", url: "/v1/public/auth/email/request-code", payload: { ...payload, turnstileToken: "valid-token" } })).statusCode, 403);
        assert.equal((await readEmailSendBudget(database)).used, 1);
        const authenticated = await app.inject({ method: "POST", url: "/v1/public/auth/email/verify-code", payload: { email: payload.email, code: sent.json().devCode } });
        assert.equal(authenticated.statusCode, 200, authenticated.body);
        const security = (await app.inject("/v1/public/auth/security")).json(); assert.deepEqual(security, { turnstileEnabled: true, turnstileSiteKey: "unit-site" });
      } finally { await app.close(); t.mock.restoreAll(); }
    });
    await t.test("verified registration writes one account and allows email verification", async () => {
      await clear();
      t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ success: true, hostname: "app.hyperspace.zone", action: "register" })));
      const config = loadConfig({ DATABASE_URL: url.toString(), TURNSTILE_ENABLED: "true", TURNSTILE_SITE_KEY: "unit-site", TURNSTILE_SECRET_KEY: "unit-secret", TURNSTILE_HOSTNAMES: "app.hyperspace.zone" });
      const app = Fastify(); registerPublicAuthRoutes(app, { db: database, protection: config.emailAuthProtection, emailAuth: { ...config.emailAuth, exposeCodes: true },
        authSessionTtlSeconds: 3600, googleOAuth: null, requireUser: async () => null, hasBillingAdminAccess: async () => false });
      try {
        const email = "registered-test@example.com";
        const registered = await app.inject({ method: "POST", url: "/v1/public/auth/register", payload: { email, password: "unit-password-long", turnstileToken: "valid-registration" } });
        assert.equal(registered.statusCode, 201, registered.body);
        assert.equal((await database.query("SELECT count(*)::int AS count FROM users")).rows[0]!.count, 1);
        const verified = await app.inject({ method: "POST", url: "/v1/public/auth/email/verify-code", payload: { email, code: registered.json().devCode } });
        assert.equal(verified.statusCode, 200, verified.body);
      } finally { await app.close(); t.mock.restoreAll(); }
    });
    await t.test("sender 429 returns bounded 503, consumes failed challenge and persists backoff", async () => {
      await clear(); let sends = 0;
      t.mock.method(globalThis, "fetch", async (address: unknown) => {
        if (String(address).includes("siteverify")) return new Response(JSON.stringify({ success: true, hostname: "app.hyperspace.zone", action: "email_otp" }));
        sends++; return new Response("private-provider-error-body", { status: 429, headers: { "retry-after": "60" } });
      });
      const config = loadConfig({ DATABASE_URL: url.toString(), EMAIL_PROVIDER: "resend", RESEND_API_KEY: "unit-secret", TURNSTILE_ENABLED: "true", TURNSTILE_SITE_KEY: "unit-site", TURNSTILE_SECRET_KEY: "unit-secret", TURNSTILE_HOSTNAMES: "app.hyperspace.zone" });
      const app = Fastify(); registerPublicAuthRoutes(app, { db: database, protection: config.emailAuthProtection, emailAuth: config.emailAuth,
        authSessionTtlSeconds: 3600, googleOAuth: null, requireUser: async () => null, hasBillingAdminAccess: async () => false });
      try {
        const failed = await app.inject({ method: "POST", url: "/v1/public/auth/email/request-code", payload: { email: "failed-test@example.com", turnstileToken: "valid-token" } });
        assert.equal(failed.statusCode, 503, failed.body); assert.doesNotMatch(failed.body, /private-provider-error-body|unit-secret/);
        assert.equal((await database.query("SELECT consumed_at IS NOT NULL AS consumed, metadata->>'delivery_status' AS state FROM email_login_challenges")).rows[0]!.state, "failed");
        assert.equal((await database.query("SELECT consumed_at IS NOT NULL AS consumed FROM email_login_challenges")).rows[0]!.consumed, true);
        assert.equal((await readEmailSendBudget(database)).used, 1);
        assert.equal((await app.inject({ method: "POST", url: "/v1/public/auth/email/request-code", payload: { email: "next-test@example.com", turnstileToken: "another-token" } })).statusCode, 503);
        assert.equal(sends, 1);
      } finally { await app.close(); t.mock.restoreAll(); }
    });
  } finally {
    await db?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.close();
  }
});
