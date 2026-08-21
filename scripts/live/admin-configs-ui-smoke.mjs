#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const webBase = (process.env.HS_WEB_BASE || "https://app.staging.hyperspace.zone").replace(/\/$/, "");
const accessToken = process.env.HS_ACCESS_TOKEN || "";
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/snap/bin/chromium";
const outputDir = process.env.HS_SCREENSHOT_DIR || "/tmp/hyperspace-staging-admin-smoke";

assert(accessToken, "HS_ACCESS_TOKEN is required");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: chromiumExecutable,
  headless: process.env.HS_HEADLESS !== "false",
  args: ["--no-sandbox"]
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await page.addInitScript((token) => localStorage.setItem("hyperspaceAccessToken", token), accessToken);
  await page.goto(`${webBase}/admin/billing`, { waitUntil: "networkidle", timeout: 30_000 });

  await page.getByRole("heading", { name: "Network admin" }).waitFor();
  await page.getByRole("heading", { name: "Traffic consumption" }).waitFor();
  await page.getByRole("heading", { name: "VPN configs" }).waitFor();
  await page.getByRole("heading", { name: "Config payments" }).waitFor();
  await page.getByRole("heading", { name: "Deposits", exact: true }).waitFor();

  const overview = await page.evaluate(async () => {
    const response = await fetch("/api/v1/admin/billing/customers", {
      headers: { authorization: `Bearer ${localStorage.getItem("hyperspaceAccessToken")}` }
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(overview.status, 200, "admin overview API is unavailable to the configured administrator");
  assert(Array.isArray(overview.body.configs), "admin overview did not return configs");
  assert(Array.isArray(overview.body.payments), "admin overview did not return payments");
  assert(Array.isArray(overview.body.deposits), "admin overview did not return deposits");

  await page.locator('[data-admin-traffic-range="7d"]').click();
  await page.waitForFunction(() => !document.querySelector("#refresh-admin-traffic")?.hasAttribute("disabled"));
  assert.equal(await page.locator('[data-admin-traffic-range="7d"]').getAttribute("class"), "active");

  const configSelect = page.locator("#admin-traffic-config");
  if (await configSelect.locator("option").count() > 1) {
    await configSelect.selectOption({ index: 1 });
    await page.waitForFunction(() => !document.querySelector("#refresh-admin-traffic")?.hasAttribute("disabled"));
    await configSelect.selectOption("");
    await page.waitForFunction(() => !document.querySelector("#refresh-admin-traffic")?.hasAttribute("disabled"));
  }

  const screenshotPath = `${outputDir}/network-admin-live.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true });
  assert.deepEqual(pageErrors, []);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    webBase,
    customers: overview.body.customers.length,
    configs: overview.body.configs.length,
    payments: overview.body.payments.length,
    deposits: overview.body.deposits.length,
    screenshotPath
  }, null, 2)}\n`);
} finally {
  await browser.close();
}
