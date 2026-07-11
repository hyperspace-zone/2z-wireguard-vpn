#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { createResendAuthHelper, uniqueResendAddress } from "./resend-auth-helper.mjs";

const webBase = stripTrailingSlash(process.env.HS_WEB_BASE || "https://app.testnet.hyperspace.zone");
const apiBase = stripTrailingSlash(process.env.HS_API_BASE || `${webBase}/api`);
const outputDir = process.env.HS_TEST_OUTPUT_DIR || "m1-results/live-testnet";
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/snap/bin/chromium";
const targetIp = process.env.HS_TEST_TARGET_IP || "1.1.1.1";
const preferredIngress = process.env.HS_TEST_INGRESS || "gate-eu-fra-01";
const preferredEgress = process.env.HS_TEST_EGRESS || "gate-eu-lon-01";
const headless = process.env.HS_HEADLESS !== "false";
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const email = process.env.HS_TEST_EMAIL || uniqueResendAddress("codex-live");
const password = process.env.HS_TEST_PASSWORD || `Codex-live-${Date.now()}-strong-password`;
const existingVerifiedAccount = process.env.HS_TEST_EXISTING_ACCOUNT === "true";
const label = `codex-live-${runId}`;

await mkdir(outputDir, { recursive: true });

const api = makeApiClient(apiBase);
const resendAuth = createResendAuthHelper({ api });
const health = await api("/health");
assert(health?.ok === true, "API health did not return ok=true");

const gatesResponse = await api("/v1/public/gates");
const gates = Array.isArray(gatesResponse?.gates) ? gatesResponse.gates : [];
const schedulableGates = gates.filter((gate) => gate.ready === true && gate.schedulable === true);
assert(schedulableGates.length >= 2, "expected at least two ready/schedulable gates");

const ingress = findGate(schedulableGates, preferredIngress) || schedulableGates[0];
const egress = findGate(schedulableGates, preferredEgress, ingress.name) ||
  schedulableGates.find((gate) => gate.name !== ingress.name);
assert(ingress && egress && ingress.name !== egress.name, "expected distinct ingress and egress gates");

const result = {
  runId,
  webBase,
  apiBase,
  email,
  targetIp,
  ingressGateName: ingress.name,
  egressGateName: egress.name,
  gates: schedulableGates.map((gate) => ({
    name: gate.name,
    ready: gate.ready,
    schedulable: gate.schedulable,
    doubleZero: gate.doubleZero || null
  })),
  steps: []
};

const browser = await chromium.launch({ headless, executablePath: chromiumExecutable });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") {
    consoleErrors.push(message.text());
  }
});
page.on("pageerror", (error) => {
  pageErrors.push(error.message);
});

try {
  if (!existingVerifiedAccount) {
    await page.goto(`${webBase}/register`, { waitUntil: "networkidle" });
    await screenshot(page, "01-register");
    assert(await page.locator("#event-log").count() === 0, "event log must not be visible on register page");
    await expectText(page, "Register");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    const registrationResponsePromise = page.waitForResponse((response) =>
      response.url().includes("/v1/public/auth/register") && response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Register" }).click();
    const registrationResponse = await registrationResponsePromise;
    const registration = await registrationResponse.json();
    await page.waitForURL(`${webBase}/login`, { timeout: 30000 });
    const verificationCode = registration.devCode || await resendAuth.waitForOtp(email);
    await page.locator("#email-code-verify-form input[name=code]").fill(verificationCode);
    await page.locator("#email-code-verify-form button[type=submit]").click();
    await page.waitForURL(`${webBase}/`, { timeout: 30000 });
    await expectText(page, "Dashboard");
    result.steps.push("registered_and_verified");
    await page.getByRole("button", { name: "Log out" }).click();
    await page.waitForURL(`${webBase}/login`, { timeout: 30000 });
  } else {
    await page.goto(`${webBase}/login`, { waitUntil: "networkidle" });
  }
  await expectText(page, "Log in");
  assert(await page.locator("#event-log").count() === 0, "event log must not be visible on login page");
  await page.locator('#login-form input[name="email"]').fill(email);
  await page.locator('#login-form input[name="password"]').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL(`${webBase}/`, { timeout: 30000 });
  await expectText(page, "VPN configs");
  await expectText(page, "Benchmarks");
  result.steps.push("logged_in");

  await expectText(page, "Solana deposit wallet");
  const depositAddress = (await page.locator(".wallet-row").first().textContent())?.trim() || "";
  assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(depositAddress), "custodial Solana deposit address is missing or invalid");
  await page.locator('#topup-form input[name="amountUsd"]').fill("1.00");
  await page.locator('#topup-form button[type="submit"]').click();
  await page.getByRole("link", { name: "Pay with Solana wallet" }).first().waitFor({ timeout: 30000 });
  result.custodialWallet = depositAddress;
  result.steps.push("custodial_wallet_and_solana_pay_checked");

  await expectText(page, "Ready");
  await expectText(page, "Schedulable");
  await expectText(page, "DoubleZero node");
  await expectText(page, "Browser RTT");
  assert(await page.getByText("Gate benchmark routes").count() === 0, "benchmark table must not be rendered on dashboard");
  await page.getByRole("button", { name: /Measure browser RTT|Measuring/ }).click().catch(() => undefined);
  await page.waitForTimeout(5000);
  await screenshot(page, "02-dashboard-gates");
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "dashboard overflows the mobile viewport");
  await screenshot(page, "02-dashboard-mobile");
  await page.setViewportSize({ width: 1280, height: 720 });
  result.steps.push("dashboard_gates_checked");

  await page.getByRole("link", { name: "Benchmarks" }).click();
  await page.waitForURL(`${webBase}/benchmarks`, { timeout: 30000 });
  await expectText(page, "Gate benchmark routes — RTT");
  await expectText(page, "Gate benchmark routes — One-Way");
  await expectText(page, "DZ vs Internet");
  await expectText(page, "City filter");
  await expectText(page, "RTT Improvement");
  await expectText(page, "RTT Saved");
  await expectText(page, "Loss");
  await expectText(page, "Ingress gate ↔ DZ RTT");
  await expectText(page, "Egress gate ↔ DZ RTT");
  await expectText(page, "DZ RTT Jitter");
  await expectText(page, "Internet RTT Jitter");
  await expectText(page, "RTT Jitter Improvement");
  await expectText(page, "RTT Jitter Saved");
  await expectText(page, "DZ One-Way");
  await expectText(page, "Internet One-Way");
  await expectText(page, "One-Way Improvement");
  await expectText(page, "One-Way Saved");
  await expectText(page, "fresh within 15m");
  await expectText(page, "Legend:");
  await screenshot(page, "03-benchmarks");
  result.steps.push("benchmarks_checked");

  await page.getByRole("link", { name: "Create config" }).first().click();
  await page.waitForURL(`${webBase}/create-config`, { timeout: 30000 });
  await expectText(page, "Step 1");
  await page.locator('input[name="label"]').fill(label);
  await page.locator('input[name="targetIp"]').fill(targetIp);
  await page.locator('select[name="ingressGateName"]').selectOption(ingress.name);
  await page.locator('select[name="egressGateName"]').selectOption("");
  await page.getByRole("button", { name: "Review config" }).click();
  await expectText(page, "Select an egress gate.");
  result.steps.push("egress_validation_checked");

  const preferredRegion = gateRegionFromName(egress.name);
  const excludedCountry = schedulableGates.find((gate) =>
    gate.country && ![ingress.country, egress.country].includes(gate.country)
  )?.country;
  const excludedCity = schedulableGates.find((gate) =>
    gate.city && ![ingress.city, egress.city].includes(gate.city) && gate.country !== excludedCountry
  )?.city;
  if (preferredRegion) {
    await page.locator('select[name="preferredRegion"]').selectOption(preferredRegion);
  }
  if (excludedCountry) {
    await page.getByText("Excluded countries", { exact: true }).click();
    await page.locator(`input[name="excludeCountry"][value="${excludedCountry}"]`).check();
  }
  if (excludedCity) {
    await page.getByText("Excluded cities", { exact: true }).click();
    await page.locator(`input[name="excludeCity"][value="${excludedCity}"]`).check();
  }
  await page.locator('select[name="egressGateName"]').selectOption(egress.name);
  await page.getByRole("button", { name: "Review config" }).click();
  await expectText(page, "Step 2");
  await expectText(page, "Confirm and create");
  if (excludedCountry) await expectText(page, `Avoid countries: ${excludedCountry}`);
  if (excludedCity) await expectText(page, `Avoid cities: ${excludedCity}`);
  const reviewText = await page.locator(".review-step").innerText();
  assert(!/RTT/i.test(reviewText), "review route overview must not show browser RTT values");
  await screenshot(page, "03-review");

  await page.getByRole("button", { name: "Confirm and create" }).click();
  await page.waitForURL(`${webBase}/`, { timeout: 30000 });
  await expectText(page, label);
  result.steps.push("config_requested");

  const accessToken = await page.evaluate(() => localStorage.getItem("hyperspaceAccessToken"));
  assert(accessToken, "browser did not store access token");
  const authedApi = makeApiClient(apiBase, accessToken);
  const session = await waitForSessionPhase(authedApi, label, "active", 300000);
  result.sessionId = session.id;
  result.steps.push("config_active");
  await page.goto(`${webBase}/`, { waitUntil: "networkidle" });
  await expectText(page, label);
  await screenshot(page, "04-active");

  const tokenResponse = await authedApi(`/v1/public/sessions/${session.id}/artifacts/client-config/download-token`, {
    method: "POST"
  });
  assert(typeof tokenResponse.downloadUrl === "string", "downloadUrl missing");
  assert(typeof tokenResponse.downloadConfigUrl === "string", "downloadConfigUrl missing");

  const rawConfig = await fetchText(resolveApiUrl(apiBase, tokenResponse.downloadConfigUrl), accessToken);
  assert(rawConfig.includes("[Interface]"), "raw config missing [Interface]");
  assert(rawConfig.includes("[Peer]"), "raw config missing [Peer]");
  assert(!rawConfig.trim().startsWith("{"), "raw config endpoint returned JSON instead of .conf text");
  result.rawConfig = {
    byteLength: Buffer.byteLength(rawConfig, "utf8"),
    hasInterface: rawConfig.includes("[Interface]"),
    hasPeer: rawConfig.includes("[Peer]"),
    hasEndpoint: rawConfig.includes("Endpoint = "),
    hasAllowedIps: rawConfig.includes("AllowedIPs = ")
  };
  result.steps.push("raw_config_validated");

  const row = page.locator("tr", { hasText: label }).first();
  await row.getByRole("button", { name: "QR" }).click();
  await page.getByRole("dialog", { name: "WireGuard configuration QR code" }).waitFor({ timeout: 30000 });
  assert(await page.locator(".qr-dialog svg").count() === 1, "WireGuard QR modal did not contain an SVG code");
  await screenshotViewport(page, "04-config-qr");
  await page.getByRole("button", { name: "Close" }).click();
  result.steps.push("ui_qr_checked");

  const [connectHelper] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    row.getByRole("button", { name: "Connect" }).click()
  ]);
  assert(/hyperspace-connect\.(sh|command|ps1)$/.test(connectHelper.suggestedFilename()), "connect helper filename is invalid");
  result.steps.push("connect_helper_downloaded");

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    row.getByRole("button", { name: "Download" }).click()
  ]);
  assert(download.suggestedFilename().endsWith(".conf"), "UI download filename must end with .conf");
  result.steps.push("ui_download_clicked");

  await row.getByRole("button", { name: "Revoke" }).click();
  await waitForSessionPhase(authedApi, label, "revoked", 300000);
  result.steps.push("config_revoked");
  await page.goto(`${webBase}/`, { waitUntil: "networkidle" });
  await expectText(page, label);

  const revokedRow = page.locator("tr", { hasText: label }).first();
  await revokedRow.getByRole("button", { name: "Delete" }).click();
  await waitForSessionDeleted(authedApi, session.id, 60000);
  await page.waitForTimeout(1500);
  assert(await page.locator("tr", { hasText: label }).count() === 0, "deleted config is still visible in dashboard");
  await screenshot(page, "05-deleted");
  result.steps.push("config_deleted");

  assert(consoleErrors.length === 0, `browser console errors: ${consoleErrors.join(" | ")}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join(" | ")}`);
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.error = error instanceof Error ? error.message : String(error);
  await screenshot(page, "failure").catch(() => undefined);
  throw error;
} finally {
  result.consoleErrors = consoleErrors;
  result.pageErrors = pageErrors;
  await writeFile(path.join(outputDir, `live-ui-smoke-${runId}.json`), JSON.stringify(result, null, 2));
  await browser.close();
}

console.log(JSON.stringify(result, null, 2));

async function screenshot(page, name) {
  await page.screenshot({ path: path.join(outputDir, `${runId}-${name}.png`), fullPage: true });
}

async function screenshotViewport(page, name) {
  await page.screenshot({ path: path.join(outputDir, `${runId}-${name}.png`), fullPage: false });
}

function makeApiClient(base, token = "") {
  return async function apiRequest(apiPath, options = {}) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(resolveApiUrl(base, apiPath), {
        method: options.method || "GET",
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {})
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;
      if (response.status === 429 && attempt < 4) {
        const retryAfterSeconds = Math.max(1, Number(response.headers.get("retry-after") || 1));
        await wait(retryAfterSeconds * 1000);
        continue;
      }
      if (!response.ok) {
        throw new Error(`${options.method || "GET"} ${apiPath} failed: ${response.status} ${text}`);
      }
      return payload;
    }
    throw new Error(`${options.method || "GET"} ${apiPath} exhausted rate-limit retries`);
  };
}

async function fetchText(url, token) {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${text}`);
  }
  return text;
}

async function waitForSessionPhase(api, sessionLabel, expectedPhase, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastSession = null;
  while (Date.now() < deadline) {
    const response = await api("/v1/public/sessions");
    const sessions = Array.isArray(response?.sessions) ? response.sessions : [];
    lastSession = sessions.find((session) => session.label === sessionLabel) || lastSession;
    if (lastSession?.phase === expectedPhase) {
      return lastSession;
    }
    if (lastSession?.phase === "failed") {
      throw new Error(`session ${lastSession.id} failed: ${JSON.stringify(lastSession.lastError || {})}`);
    }
    await wait(1500);
  }
  throw new Error(`timed out waiting for ${sessionLabel} to reach phase ${expectedPhase}; last=${JSON.stringify(lastSession)}`);
}

async function waitForSessionDeleted(api, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await api("/v1/public/sessions");
    const sessions = Array.isArray(response?.sessions) ? response.sessions : [];
    if (!sessions.some((session) => session.id === sessionId)) {
      return;
    }
    await wait(1500);
  }
  throw new Error(`timed out waiting for session ${sessionId} to disappear`);
}

async function expectText(page, text) {
  await page.getByText(text, { exact: false }).first().waitFor({ timeout: 30000 });
}

function findGate(gates, name, notName = "") {
  return gates.find((gate) => gate.name === name && gate.name !== notName);
}

function gateRegionFromName(name) {
  const region = name.split("-")[1] || "";
  return ["eu", "na", "ap", "sa"].includes(region) ? region : "";
}

function resolveApiUrl(base, pathOrUrl) {
  if (/^https?:\/\//.test(pathOrUrl)) {
    return pathOrUrl;
  }
  return `${stripTrailingSlash(base)}/${pathOrUrl.replace(/^\/+/, "")}`;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
