#!/usr/bin/env node

import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const webBase = (process.env.HS_WEB_BASE || "https://app.staging.hyperspace.zone").replace(/\/$/, "");
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/snap/bin/chromium";
const gatesResponse = await fetch(`${webBase}/api/v1/public/gates`).then(readJsonResponse);
const schedulableGates = gatesResponse.gates.filter((gate) => gate.ready === true && gate.schedulable === true);
assert(schedulableGates.length >= 2, "expected at least two schedulable gates");

const browser = await chromium.launch({
  executablePath: chromiumExecutable,
  headless: process.env.HS_HEADLESS !== "false",
  args: ["--no-sandbox"]
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await page.addInitScript(() => localStorage.setItem("hyperspaceAccessToken", "gate-selector-smoke-token"));
  await page.route("**/api/v1/public/gates", (route) => route.abort("failed"));
  await mockJson(page, "**/api/v1/public/auth/me", {
    user: {
      id: "gate-selector-smoke-user",
      email: "gate-selector-smoke@hyperspace.zone",
      displayName: "Gate selector smoke",
      avatarUrl: null
    },
    capabilities: []
  });
  await mockJson(page, "**/api/v1/public/sessions", { sessions: [] });
  await mockJson(page, "**/api/v1/public/billing", {});

  await page.goto(`${webBase}/create-config`, { waitUntil: "networkidle", timeout: 30_000 });
  await page.getByText("Optional settings", { exact: true }).click();
  const ingress = page.locator('select[name="ingressGateName"]');
  const expectedGateNames = schedulableGates.map((gate) => gate.name).sort();
  assert.deepEqual(await optionValues(ingress), expectedGateNames, "benchmark fallback did not restore ingress gates");

  const countries = [...new Set(schedulableGates.map((gate) => gate.country).filter(Boolean))];
  for (const country of countries) {
    await page.getByText("Excluded countries", { exact: true }).click();
    await page.locator(`input[name="excludeCountry"][value="${country}"]`).check();
  }
  assert.equal(
    (await ingress.locator("option").first().textContent())?.trim(),
    "No ingress gates match routing policy"
  );

  await page.getByRole("button", { name: "Clear routing policy" }).click();
  assert.deepEqual(await optionValues(ingress), expectedGateNames, "clearing routing policy did not restore ingress gates");
  assert.deepEqual(pageErrors, []);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    webBase,
    schedulableGateNames: expectedGateNames,
    fallbackVerified: true,
    routingPolicyRecoveryVerified: true
  }, null, 2)}\n`);
} finally {
  await browser.close();
}

async function mockJson(page, pattern, body) {
  await page.route(pattern, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body)
  }));
}

async function optionValues(locator) {
  return locator.locator("option").evaluateAll((options) => options.map((option) => option.value).filter(Boolean).sort());
}

async function readJsonResponse(response) {
  const body = await response.json();
  assert(response.ok, `request failed with HTTP ${response.status}`);
  return body;
}
