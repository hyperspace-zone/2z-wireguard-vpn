#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const webDir = join(repoRoot, "apps/web");
const distDir = join(webDir, "dist");
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/snap/bin/chromium";
const headless = process.env.PLAYWRIGHT_HEADLESS !== "0";
const requestedBaseUrl = process.env.HS_WEB_BASE?.replace(/\/$/, "") || "";
const screenshotDir = process.env.HS_TEST_OUTPUT_DIR || "";
const testEmail = "pilot-ui-smoke@vutcenoi.resend.app";
const testPassword = `Ui-${randomBytes(18).toString("base64url")}`;
const mockedOtp = String(randomInt(100_000, 1_000_000));

execFileSync("npm", ["--workspace", "@hyperspace-zone/web", "run", "build"], {
  cwd: repoRoot,
  stdio: "inherit"
});

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  const filePath = join(distDir, pathname === "/" ? "index.html" : pathname);
  try {
    const body = await readFile(filePath);
    response.writeHead(200, { "content-type": contentType(filePath) });
    response.end(body);
  } catch {
    const index = await readFile(join(distDir, "index.html"));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(index);
  }
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("could not start local web server");
}
const baseUrl = requestedBaseUrl || `http://127.0.0.1:${address.port}`;
if (screenshotDir) {
  await mkdir(screenshotDir, { recursive: true });
}

let createdSessionPayload = null;
const createdSessionAttempts = [];
let registeredUserPayload = null;
let authenticated = false;
let googleRedirectAfter = null;
let createdSessionPollCount = 0;
const sessions = [];
const depositWalletPublicKey = "6TQxgf6T4DRqk2r6WwCSw8uFsAdWbym3G8Yt19cZX7wt";
const depositSignature = "3nRbdPZB7sbmMRacYiepTbAXvDi15JdSoV3eXsUi1UJVTeeFceEyNcnEqFMRGSMq3mKiu5G2ansgpvfDsBCiRo4y";
const gates = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    name: "gate-eu-ams-21",
    city: "Amsterdam",
    country: "Netherlands",
    publicIpv4: "203.0.113.10",
    ready: true,
    schedulable: true,
    desiredState: "Enabled"
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    name: "gate-na-sjc-01",
    city: "San Jose",
    country: "United States",
    publicIpv4: "203.0.113.20",
    ready: true,
    schedulable: true,
    desiredState: "Enabled"
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    name: "gate-eu-fra-21",
    city: "Frankfurt",
    country: "Germany",
    publicIpv4: "203.0.113.30",
    ready: true,
    schedulable: true,
    desiredState: "Enabled"
  }
];

const browser = await chromium.launch({ headless, executablePath: chromiumExecutable });
try {
  const page = await browser.newPage();
  await page.route("**/api/v1/public/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api", "");
    const method = request.method();
    const auth = request.headers().authorization || "";
    const okAuth = authenticated || auth === "Bearer test-token";

    if (path === "/v1/public/gates") {
      return json(route, { gates });
    }
    if (path === "/v1/public/benchmarks/gate-matrix") {
      return json(route, { generatedAt: new Date().toISOString(), gates, routes: [] });
    }
    if (path === "/v1/public/auth/email/request-code" && method === "POST") {
      return json(route, {
        status: "sent",
        email: testEmail,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        devCode: mockedOtp
      });
    }
    if (path === "/v1/public/auth/register" && method === "POST") {
      registeredUserPayload = request.postDataJSON();
      return json(route, {
        status: "sent",
        email: registeredUserPayload.email,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        devCode: mockedOtp
      }, 201);
    }
    if (path === "/v1/public/auth/google/start" && method === "GET") {
      googleRedirectAfter = url.searchParams.get("redirect");
      return json(route, {
        authorizationUrl: `${baseUrl}/mock-google-authorization`,
        expiresAt: new Date(Date.now() + 600_000).toISOString()
      });
    }
    if (path === "/v1/public/auth/email/verify-code" && method === "POST") {
      if (request.postDataJSON().code !== mockedOtp) {
        return json(route, { error: "invalid_code" }, 401);
      }
      authenticated = true;
      return json(route, {
        user: { id: "user-1", accountId: "account-1", email: testEmail, displayName: "Pilot", avatarUrl: null },
        accessToken: "test-token",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      });
    }
    if (path === "/v1/public/auth/me") {
      return okAuth
        ? json(route, { user: { id: "user-1", accountId: "account-1", email: testEmail, displayName: "Pilot", avatarUrl: null } })
        : json(route, { error: "auth_required" }, 401);
    }
    if (path === "/v1/public/billing") {
      return json(route, {
        accountId: "account-1",
        balanceMinor: 2500000,
        currency: "SOL",
        ledger: [],
        deposit: {
          chain: "solana", address: depositWalletPublicKey, tokenSymbol: "SOL", tokenMint: "native", tokenDecimals: 9,
          qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>'
        },
        deposits: [{
          transactionSignature: depositSignature, chain: "solana", status: "finalized", tokenSymbol: "SOL", tokenMint: "native",
          tokenAmountBaseUnits: "1819440", tokenDecimals: 9, creditedAmountMinor: 1819440, currency: "SOL",
          observedAt: new Date().toISOString(), explorerUrl: `https://orbmarkets.io/tx/${depositSignature}`
        }],
        availableBalanceMinor: 2500,
        withdrawableBalanceMinor: 2500,
        buckets: { cashMinor: 2500, promotionalMinor: 0, reservedWithdrawalMinor: 0, debtMinor: 0 },
        state: { state: "active", overdrawnAt: null, suspensionDueAt: null, suspendedAt: null, withdrawalEligibleAt: null, lastSettledAt: null },
        plan: { code: "standard", version: 1, displayName: "Standard", activeConfigMonthlyMinor: 100, trafficPerGbMinor: 10, gracePeriodSeconds: 86400, withdrawalCooldownSeconds: 86400, minimumWithdrawalMinor: 100 },
        usage: [],
        withdrawals: [],
        walletBalanceBaseUnits: "2500000",
        walletSpendableBaseUnits: "1609120",
        walletRentReserveBaseUnits: "890880",
        configPriceBaseUnits: "100000"
      });
    }
    if (path === "/v1/public/sessions" && method === "GET") {
      if (sessions.length > 0) {
        createdSessionPollCount += 1;
        if (createdSessionPollCount >= 2) sessions[0].phase = "active";
      }
      return json(route, { sessions });
    }
    if (path === "/v1/public/sessions" && method === "POST") {
      createdSessionPayload = request.postDataJSON();
      createdSessionAttempts.push(createdSessionPayload);
      if (createdSessionAttempts.length === 1) {
        return json(route, {
          error: "insufficient_solana_funds",
          message: "Insufficient SOL for the 0.0001 SOL config payment and Solana network fee. Top up on Billing and try again."
        }, 402);
      }
      const session = {
        id: "session-1", mode: createdSessionPayload.mode, desiredState: "Active", phase: "provisioning",
        destinationCidrs: ["1.1.1.1/32"], sourceCidr: null, label: "Smoke config",
        selectedPath: { ingressGateName: createdSessionPayload.ingressGateName, egressGateName: createdSessionPayload.egressGateName },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      sessions.splice(0, sessions.length, session);
      return json(route, { session }, 201);
    }
    if (path.endsWith("/artifacts/client-config/download-token") && method === "POST") {
      return json(route, { token: "artifact-token", expiresAt: new Date(Date.now() + 300_000).toISOString(), downloadUrl: "/v1/public/artifacts/download/artifact-token", downloadConfigUrl: "/v1/public/artifacts/download/artifact-token?format=conf" });
    }
    if (path === "/v1/public/artifacts/download/artifact-token") {
      if (url.searchParams.get("format") === "qr") {
        return route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>' });
      }
      if (url.searchParams.get("format") === "conf") {
        return route.fulfill({ status: 200, contentType: "text/plain", body: "[Interface]\nPrivateKey = hidden\n" });
      }
      return json(route, { payload: { fileName: "hyperspace-smoke.conf", configText: "[Interface]\nPrivateKey = hidden\n" } });
    }
    if (path === "/v1/public/network/me") {
      return json(route, { ip: "198.51.100.10" });
    }
    return json(route, { error: "not_mocked", path, method }, 404);
  });

  await page.goto(`${baseUrl}/login`);
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.waitForURL(`${baseUrl}/mock-google-authorization`);
  if (googleRedirectAfter !== "/login") {
    throw new Error(`expected Google redirect after /login, got ${JSON.stringify(googleRedirectAfter)}`);
  }

  await page.goto(`${baseUrl}/register`);
  await page.locator("#register-form input[name=email]").fill(testEmail);
  await page.locator("#register-form input[name=password]").fill(testPassword);
  await page.locator("#register-form button[type=submit]").click();
  await page.locator("#email-code-verify-form input[name=code]").fill(mockedOtp);
  await page.locator("#email-code-verify-form button[type=submit]").click();

  await page.getByLabel("Billing balance 0.00160912 SOL").waitFor();
  await page.getByLabel("Primary").getByRole("link", { name: "Billing", exact: true }).click();
  await page.getByRole("heading", { name: "Billing", exact: true }).waitFor();
  await page.getByText(depositWalletPublicKey, { exact: true }).waitFor();
  await page.locator(".deposit-qr svg").waitFor();
  await page.getByText("0.00181944 SOL", { exact: true }).waitFor();
  await page.getByRole("link", { name: /3nRbdPZB/ }).waitFor();
  await page.getByRole("button", { name: "Refresh deposits" }).click();
  await page.getByText("0.00181944 SOL", { exact: true }).waitFor();
  if (await page.getByRole("button", { name: /Connect external wallet/ }).count()) {
    throw new Error("external wallet linking must not be exposed");
  }
  if (await page.locator("#topup-form").count()) {
    throw new Error("fixed-amount top-up form must not be exposed");
  }
  await capture(page, "billing-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) {
    throw new Error("billing page overflows the mobile viewport");
  }
  await capture(page, "billing-mobile");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByLabel("Primary").getByRole("link", { name: "Dashboard", exact: true }).click();
  if (await page.getByRole("heading", { name: "Deposit SOL" }).count()) {
    throw new Error("billing controls must not be rendered on the dashboard");
  }
  await capture(page, "dashboard-without-billing");

  await page.getByLabel("Primary").getByRole("link", { name: "Create config" }).click();
  if (await page.locator('input[name="label"]').isVisible()) {
    throw new Error("optional config name must be collapsed by default");
  }
  if (await page.locator('input[name="restrictTarget"]').isChecked()) {
    throw new Error("simple config flow must default to unrestricted outgoing traffic");
  }
  if (await page.locator('select:visible').count() !== 1) {
    throw new Error("egress must be the only visible selector in the simple config flow");
  }
  await capture(page, "simple-config-step");
  await page.getByText("Optional settings", { exact: true }).click();
  await page.getByText("Excluded countries", { exact: true }).click();
  await page.locator('input[name="excludeCountry"][value="Germany"]').check();
  if (await page.locator("#excluded-countries-settings").getAttribute("open") !== "") {
    throw new Error("excluded countries collapsed after selecting a country");
  }
  await page.locator("#event-log").evaluate((element) => { element.style.display = "none"; });
  await capture(page, "routing-exclusions");
  await page.locator("#event-log").evaluate((element) => { element.style.display = ""; });
  await page.getByRole("button", { name: "Clear routing policy" }).click();
  await page.getByText("Optional settings", { exact: true }).click();
  await page.locator("select[name=egressGateName]").selectOption("gate-na-sjc-01");
  await page.getByRole("button", { name: "Review config" }).click();
  await page.getByText("Full tunnel", { exact: true }).first().waitFor();
  await page.getByText("0.0001 SOL", { exact: true }).waitFor();
  await capture(page, "simple-config-review");
  await page.getByRole("button", { name: "Pay 0.0001 SOL and create" }).click();
  await page.getByText("Insufficient spendable SOL for 0.0001 SOL, the network fee, and the Solana account rent reserve. Top up your wallet on Billing, then retry Confirm.", { exact: true }).waitFor();
  await page.getByRole("link", { name: "Open Billing" }).waitFor();
  await page.getByRole("button", { name: "Pay 0.0001 SOL and create" }).click();

  await page.waitForURL(`${baseUrl}/create-config`);
  await page.getByText("Preparing WireGuard config", { exact: true }).waitFor();
  await capture(page, "created-config-provisioning");
  await page.getByRole("img", { name: "WireGuard configuration QR code" }).waitFor();
  await capture(page, "created-config-result");
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) {
    throw new Error("created config result overflows the mobile viewport");
  }
  await capture(page, "created-config-result-mobile");
  await page.setViewportSize({ width: 1280, height: 720 });
  const [resultDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download config" }).click()
  ]);
  if (!resultDownload.suggestedFilename().endsWith(".conf")) {
    throw new Error(`unexpected config filename ${resultDownload.suggestedFilename()}`);
  }
  await page.getByRole("button", { name: "OK" }).click();
  await page.waitForURL(`${baseUrl}/`);

  await page.getByRole("button", { name: "QR" }).click();
  await page.getByRole("dialog", { name: "WireGuard configuration QR code" }).waitFor();
  await page.getByRole("button", { name: "Close" }).click();
  const [helperDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Connect", exact: true }).click()
  ]);
  if (!/hyperspace-connect\.(sh|command|ps1)$/.test(helperDownload.suggestedFilename())) {
    throw new Error(`unexpected helper filename ${helperDownload.suggestedFilename()}`);
  }

  await page.waitForFunction(() => window.localStorage.getItem("hyperspaceAccessToken") === "test-token");
  if (createdSessionPayload?.mode !== "FullTunnel" ||
      createdSessionPayload?.ingressGateName !== "gate-eu-ams-21" ||
      createdSessionPayload?.egressGateName !== "gate-na-sjc-01" ||
      !/^[0-9a-f-]{36}$/i.test(createdSessionPayload?.paymentRequestId || "") ||
      createdSessionPayload?.targetIp !== undefined ||
      createdSessionPayload?.pathPolicy !== undefined) {
    throw new Error(`expected one-choice full-tunnel payload, got ${JSON.stringify(createdSessionPayload)}`);
  }
  if (createdSessionAttempts.length !== 2 || createdSessionAttempts[0]?.paymentRequestId !== createdSessionAttempts[1]?.paymentRequestId) {
    throw new Error(`payment retry must reuse its idempotency key, got ${JSON.stringify(createdSessionAttempts)}`);
  }
  if (registeredUserPayload?.email !== testEmail) {
    throw new Error(`expected password registration before OTP verification, got ${JSON.stringify(registeredUserPayload)}`);
  }

  console.log(JSON.stringify({ ok: true, createdSessionPayload }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

async function capture(page, name) {
  if (!screenshotDir) return;
  await page.screenshot({ path: join(screenshotDir, `${name}.png`), fullPage: true });
}

function contentType(filePath) {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
