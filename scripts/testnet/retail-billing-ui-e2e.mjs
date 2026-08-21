#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { Keypair } from "@solana/web3.js";
import { createDatabase } from "../../packages/db/dist/index.js";
import { applyBillingCredit, registerUser } from "../../packages/control-plane/dist/index.js";

const databaseUrl = process.env.DATABASE_URL || "";
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const webBase = stripTrailingSlash(process.env.HS_WEB_BASE || "https://app.testnet.hyperspace.zone");
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/snap/bin/chromium";
const outputDir = process.env.HS_TEST_OUTPUT_DIR || "m1-results/live-testnet";
const headless = process.env.HS_HEADLESS !== "false";
const runId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
const emailDomain = process.env.RESEND_RECEIVING_DOMAIN || "vutcenoi.resend.app";
const adminEmail = `billing-ui-admin-${runId}@${emailDomain}`;
const customerEmail = `billing-ui-customer-${runId}@${emailDomain}`;
const password = `Hs-${randomBytes(20).toString("base64url")}`;
const planCode = `billing-e2e-${runId}`;
const externalWallet = Keypair.generate().publicKey.toBase58();
const depositSignature = "7".repeat(88);
const db = createDatabase({ connectionString: databaseUrl, applicationName: "hyperspace-billing-ui-e2e" });
const accountIds = [];
const result = { runId, webBase, adminEmail, customerEmail, planCode, steps: [] };

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless, executablePath: chromiumExecutable });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  const admin = await createVerifiedUser(adminEmail, "Billing UI Admin");
  const customer = await createVerifiedUser(customerEmail, "Billing UI Customer");
  accountIds.push(admin.accountId, customer.accountId);
  await db.query(
    `INSERT INTO user_roles (user_id, role, granted_by)
     VALUES ($1, 'billing_admin', 'billing-ui-e2e')`,
    [admin.id]
  );
  await applyBillingCredit(db, {
    accountId: customer.accountId,
    amountMinor: 2500,
    kind: "cash",
    sourceType: "billing_ui_e2e_cash",
    sourceId: runId,
    description: "Billing UI E2E paid balance"
  });
  await db.query(
    `INSERT INTO solana_payment_receipts (
       transaction_signature, account_id, source_type, source_id, token_mint,
       amount_base_units, credited_amount_minor, metadata
     ) VALUES ($1, $2, 'direct_deposit', $1, $3, 1819440, 181, '{"fixture":true}'::jsonb)`,
    [depositSignature, customer.accountId, process.env.SOLANA_TOKEN_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]
  );
  result.steps.push("fixtures_created");

  await login(adminEmail);
  await page.getByRole("link", { name: "Admin", exact: true }).click();
  await page.waitForURL(`${webBase}/admin/billing`, { timeout: 30_000 });
  await page.getByRole("heading", { name: "Network admin" }).waitFor();
  let customerRow = page.locator("tr", { hasText: customerEmail }).first();
  await customerRow.waitFor();

  const creditResponse = page.waitForResponse((response) =>
    response.url().includes(`/v1/admin/billing/customers/${customer.accountId}/credits`) &&
    response.request().method() === "POST"
  );
  const creditForm = customerRow.locator("form[data-admin-credit]");
  await creditForm.locator('input[name="amountUsd"]').fill("5.00");
  await creditForm.locator('input[name="reason"]').fill("Automated test credits");
  await creditForm.getByRole("button", { name: "Add" }).click();
  assert((await creditResponse).status() === 201, "manual credit request failed");
  await page.getByText("$5.00", { exact: true }).first().waitFor();
  result.steps.push("manual_promotional_credit_added");

  const planResponse = page.waitForResponse((response) =>
    response.url().endsWith("/v1/admin/billing/plans") && response.request().method() === "POST"
  );
  const planForm = page.locator("#admin-plan-create");
  await planForm.locator('input[name="code"]').fill(planCode);
  await planForm.locator('input[name="displayName"]').fill("Billing E2E Plan");
  await planForm.locator('input[name="version"]').fill("1");
  await planForm.locator('input[name="activeConfigMonthlyUsd"]').fill("9.00");
  await planForm.locator('input[name="trafficPerGbUsd"]').fill("0.25");
  await planForm.getByRole("button", { name: "Create plan version" }).click();
  assert((await planResponse).status() === 201, "plan creation failed");

  customerRow = page.locator("tr", { hasText: customerEmail }).first();
  const assignmentResponse = page.waitForResponse((response) =>
    response.url().includes(`/v1/admin/billing/customers/${customer.accountId}/plan`) &&
    response.request().method() === "POST"
  );
  const assignmentForm = customerRow.locator("form[data-admin-plan]");
  await assignmentForm.locator("select[name=plan]").selectOption(`${planCode}:1`);
  await assignmentForm.getByRole("button", { name: "Assign" }).click();
  assert((await assignmentResponse).status() === 200, "plan assignment failed");
  await customerRow.getByText(`${planCode} v1`, { exact: true }).waitFor();
  await screenshot("01-billing-admin");
  result.steps.push("versioned_plan_created_and_assigned");

  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL(`${webBase}/login`);
  await login(customerEmail);
  await page.getByLabel("Billing balance $30.00").waitFor();
  await page.getByLabel("Primary").getByRole("link", { name: "Billing", exact: true }).click();
  await page.getByRole("heading", { name: "Billing", exact: true }).waitFor();
  await page.getByText(/Paid \$25\.00.*Credits \$5\.00/).waitFor();
  await page.getByRole("link", { name: "gatekeepers@hyperspace.zone" }).waitFor();
  await page.getByText("Billing E2E Plan v1", { exact: false }).waitFor();
  await page.getByRole("heading", { name: "Deposit USDC" }).waitFor();
  await page.locator(".deposit-qr svg").waitFor();
  await page.getByText("1.81944 USDC", { exact: true }).waitFor();
  await page.getByRole("link", { name: /77777777/ }).waitFor();
  assert(await page.locator("#topup-form").count() === 0, "fixed-amount top-up form must not be present");
  assert(await page.getByRole("button", { name: /Connect external wallet/ }).count() === 0, "external wallet link must not be present");
  result.steps.push("customer_balance_and_support_checked");
  result.steps.push("cex_style_deposit_wallet_checked");

  const withdrawalResponse = page.waitForResponse((response) =>
    response.url().endsWith("/v1/public/billing/withdrawals") && response.request().method() === "POST"
  );
  await page.locator('#withdrawal-form input[name="amountUsd"]').fill("10.00");
  await page.locator('#withdrawal-form input[name="destinationAddress"]').fill(externalWallet);
  await page.locator('#withdrawal-form button[type="submit"]').click();
  assert((await withdrawalResponse).status() === 201, "withdrawal request failed");
  await page.getByText("$10.00 · cooldown", { exact: false }).waitFor();
  await page.getByText(/Available \$15\.00/).waitFor();
  await screenshot("02-customer-billing");

  const cancelResponse = page.waitForResponse((response) =>
    response.url().includes("/v1/public/billing/withdrawals/") && response.request().method() === "DELETE"
  );
  await page.getByRole("button", { name: "Cancel" }).first().click();
  assert((await cancelResponse).status() === 200, "withdrawal cancellation failed");
  await page.getByText(/Available \$25\.00/).waitFor();
  result.steps.push("withdrawal_reserved_and_cancelled");

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileOverflow = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    elements: Array.from(document.querySelectorAll("body *"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        let clippedByOverflowAncestor = false;
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const overflowX = getComputedStyle(ancestor).overflowX;
          if (["auto", "scroll", "hidden", "clip"].includes(overflowX)) {
            const ancestorRect = ancestor.getBoundingClientRect();
            if (rect.left < ancestorRect.left || rect.right > ancestorRect.right) {
              clippedByOverflowAncestor = true;
              break;
            }
          }
        }
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id,
          className: element.className instanceof SVGAnimatedString ? element.className.baseVal : String(element.className),
          text: element.textContent?.trim().replace(/\s+/g, " ").slice(0, 120) ?? "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          clippedByOverflowAncestor
        };
      })
      .filter((element) => !element.clippedByOverflowAncestor && (element.right > window.innerWidth || element.left < 0))
      .slice(0, 20)
  }));
  result.mobileOverflow = mobileOverflow;
  assert(
    mobileOverflow.documentWidth <= mobileOverflow.viewportWidth,
    `billing page overflows mobile viewport: ${JSON.stringify(mobileOverflow)}`
  );
  await screenshot("03-customer-billing-mobile");
  assert(consoleErrors.length === 0, `browser console errors: ${consoleErrors.join(" | ")}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join(" | ")}`);
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.error = error instanceof Error ? error.message : String(error);
  await screenshot("failure").catch(() => undefined);
  throw error;
} finally {
  result.consoleErrors = consoleErrors;
  result.pageErrors = pageErrors;
  await browser.close();
  await cleanup();
  await db.close();
  await writeFile(path.join(outputDir, `retail-billing-ui-e2e-${runId}.json`), JSON.stringify(result, null, 2));
}

console.log(JSON.stringify(result, null, 2));

async function createVerifiedUser(email, displayName) {
  const registration = await registerUser(db, { email, password, displayName });
  if (typeof registration === "string") throw new Error(`registration failed for ${email}: ${registration}`);
  const userResult = await db.query(
    `UPDATE identities
     SET verified_at = now(), metadata = metadata || '{"verification":"billing-ui-e2e"}'::jsonb
     WHERE provider = 'email' AND provider_subject = $1
     RETURNING account_id AS "accountId"`,
    [email]
  );
  const accountId = userResult.rows[0]?.accountId;
  if (!accountId) throw new Error(`email identity was not created for ${email}`);
  const result = await db.query(
    `SELECT id, account_id AS "accountId" FROM users WHERE account_id = $1 AND email = $2`,
    [accountId, email]
  );
  if (!result.rows[0]) throw new Error(`user was not created for ${email}`);
  return result.rows[0];
}

async function login(email) {
  await page.goto(`${webBase}/login`, { waitUntil: "networkidle" });
  await page.locator('#login-form input[name="email"]').fill(email);
  await page.locator('#login-form input[name="password"]').fill(password);
  const response = page.waitForResponse((candidate) =>
    candidate.url().endsWith("/v1/public/auth/login") && candidate.request().method() === "POST"
  );
  await page.locator('#login-form button[type="submit"]').click();
  assert((await response).status() === 200, `login failed for ${email}`);
  await page.waitForURL(`${webBase}/`, { timeout: 30_000 });
}

async function cleanup() {
  if (accountIds.length > 0) {
    await db.query("DELETE FROM withdrawal_requests WHERE account_id = ANY($1::uuid[])", [accountIds]);
    await db.query("DELETE FROM audit_events WHERE account_id = ANY($1::uuid[])", [accountIds]);
    await db.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [accountIds]);
  }
  await db.query("DELETE FROM billing_plan_versions WHERE code = $1", [planCode]);
}

async function screenshot(name) {
  await page.screenshot({ path: path.join(outputDir, `${runId}-${name}.png`), fullPage: true });
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
