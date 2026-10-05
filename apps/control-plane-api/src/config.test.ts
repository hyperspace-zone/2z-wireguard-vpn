import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("native SOL billing defaults use the commercial config price and traffic allowance", () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://hyperspace:secret@db.test/hyperspace",
    SOLANA_ASSET_KIND: "native",
    SOLANA_CONFIG_PAYMENT_ENABLED: "true",
    SOLANA_REVENUE_TREASURY_ADDRESS: "DWAg34bbga73yiCh1ic9KLAv3B7FDk62GmUcamXF2Ds8"
  });

  assert.equal(config.billing.solanaAssetKind, "native");
  assert.equal(config.billing.solanaTokenSymbol, "SOL");
  assert.equal(config.billing.solanaTokenMint, "native");
  assert.equal(config.billing.solanaTokenDecimals, 9);
  assert.equal(config.billing.solanaTokenBaseUnitsPerBillingMinor, 1);
  assert.equal(config.billing.configPriceLamports, 100_000_000);
  assert.equal(config.billing.configTrafficLimitBytes, 50_000_000_000);
  assert.equal(config.billing.configPaymentEnabled, true);
});

test("auth protection is bounded and trusts only loopback by default", () => {
  const config = loadConfig({ DATABASE_URL: "postgres://unit" });
  assert.deepEqual(config.trustedProxyCidrs, ["127.0.0.1", "::1"]);
  assert.equal(config.emailAuthProtection.budget.dailyMax, 80);
  assert.equal(config.emailAuthProtection.budget.cooldownSeconds, 60);
  assert.equal(config.emailAuthProtection.budget.emailMax, 3);
  assert.equal(config.emailAuthProtection.turnstile.enabled, false);
});
test("enabled Turnstile fails startup with incomplete configuration and reads a secret file", () => {
  assert.throws(() => loadConfig({ DATABASE_URL: "postgres://unit", TURNSTILE_ENABLED: "true" }), /Turnstile requires/);
  const dir = mkdtempSync(join(tmpdir(), "hs-turnstile-unit-"));
  try {
    const file = join(dir, "secret"); writeFileSync(file, " unit-secret\n", { mode: 0o600 });
    const config = loadConfig({ DATABASE_URL: "postgres://unit", TURNSTILE_ENABLED: "true", TURNSTILE_SITE_KEY: "unit-site", TURNSTILE_SECRET_KEY_FILE: file,
      TURNSTILE_HOSTNAMES: "app.hyperspace.zone", TRUSTED_PROXY_CIDRS: "127.0.0.1,::1,84.32.83.69", EMAIL_OTP_DAILY_MAX: "50" });
    assert.equal(config.emailAuthProtection.turnstile.secretKey, "unit-secret"); assert.equal(config.emailAuthProtection.budget.dailyMax, 50);
    assert.deepEqual(config.trustedProxyCidrs, ["127.0.0.1", "::1", "84.32.83.69"]);
  } finally { rmSync(dir, { recursive: true }); }
});

test("billing administrator emails are normalized and deduplicated", () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://hyperspace:secret@db.test/hyperspace",
    BILLING_ADMIN_EMAILS: " Admin@Hyperspace.Zone,operator@hyperspace.zone admin@hyperspace.zone invalid"
  });

  assert.deepEqual(config.billingAdminEmails, ["admin@hyperspace.zone", "operator@hyperspace.zone"]);
});

test("benchmark reads use a small bounded database pool by default", () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://hyperspace:secret@db.test/hyperspace"
  });

  assert.equal(config.benchmarkDatabaseMaxConnections, 2);
  assert.equal(config.benchmarkDatabaseStatementTimeoutMs, 8_000);
});
