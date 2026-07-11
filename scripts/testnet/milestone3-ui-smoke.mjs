#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const webDir = join(repoRoot, "apps/web");
const distDir = join(webDir, "dist");
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/snap/bin/chromium";
const headless = process.env.PLAYWRIGHT_HEADLESS !== "0";
const testEmail = "pilot-ui-smoke@ostealmar.resend.app";
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
const baseUrl = `http://127.0.0.1:${address.port}`;

let createdSessionPayload = null;
let registeredUserPayload = null;
let authenticated = false;
let googleRedirectAfter = null;
let walletLinkPayload = null;
let externalWalletLinked = false;
let topups = [];
const sessions = [];
const externalWalletPublicKey = "Ammp1YcgfiAhr7xaaBDaUYn7MDk7dPHv3yWUDvdX5fKB";
const depositWalletPublicKey = "6TQxgf6T4DRqk2r6WwCSw8uFsAdWbym3G8Yt19cZX7wt";
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
  await page.addInitScript(({ publicKey }) => {
    const key = { toString: () => publicKey };
    window.solana = {
      publicKey: key,
      async connect() { return { publicKey: key }; },
      async signMessage() { return { signature: new Uint8Array(64).fill(7) }; }
    };
  }, { publicKey: externalWalletPublicKey });
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
        balanceMinor: 2500,
        currency: "USD",
        ledger: [],
        topups
      });
    }
    if (path === "/v1/public/auth/wallets") {
      return json(route, { wallets: [
        { id: "wallet-custodial", chain: "solana", publicKey: depositWalletPublicKey, label: "Hyperspace deposit wallet", linkedAt: new Date().toISOString(), custody: "hyperspace", canReceive: true },
        ...(externalWalletLinked ? [{ id: "wallet-external", chain: "solana", publicKey: externalWalletPublicKey, label: null, linkedAt: new Date().toISOString(), custody: "external", canReceive: true }] : [])
      ] });
    }
    if (path === "/v1/public/auth/wallets/solana/challenge" && method === "POST") {
      return json(route, { chain: "solana", publicKey: externalWalletPublicKey, nonce: "wallet-nonce", message: "Link wallet", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    }
    if (path === "/v1/public/auth/wallets/solana/link" && method === "POST") {
      walletLinkPayload = request.postDataJSON();
      externalWalletLinked = true;
      return json(route, { wallet: { id: "wallet-external", chain: "solana", publicKey: externalWalletPublicKey, label: null, linkedAt: new Date().toISOString(), custody: "external", canReceive: true } });
    }
    if (path === "/v1/public/billing/topups" && method === "POST") {
      const input = request.postDataJSON();
      const topup = {
        id: "topup-1", provider: "solana", status: "pending", amountMinor: input.amountMinor, currency: "USD",
        chain: "solana", tokenSymbol: "USDC", tokenMint: "mint", treasuryAddress: depositWalletPublicKey,
        reference: externalWalletPublicKey, expectedSender: input.expectedSender || null, transactionSignature: null,
        paymentUrl: `solana:${depositWalletPublicKey}?amount=25&spl-token=mint&reference=${externalWalletPublicKey}`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(), submittedAt: null, confirmedAt: null, createdAt: new Date().toISOString()
      };
      topups = [topup];
      return json(route, { topup }, 201);
    }
    if (path === "/v1/public/sessions" && method === "GET") {
      return json(route, { sessions });
    }
    if (path === "/v1/public/sessions" && method === "POST") {
      createdSessionPayload = request.postDataJSON();
      const session = {
        id: "session-1", mode: createdSessionPayload.mode, desiredState: "Active", phase: "active",
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

  await page.getByRole("heading", { name: "Account" }).waitFor();
  await page.getByText("$25.00").waitFor();
  await page.getByRole("button", { name: "Connect external wallet (optional)" }).click();
  await page.getByText(/External:/).waitFor();
  if (walletLinkPayload?.publicKey !== externalWalletPublicKey || walletLinkPayload?.nonce !== "wallet-nonce") {
    throw new Error(`expected injected Solana wallet link payload, got ${JSON.stringify(walletLinkPayload)}`);
  }

  await page.locator("#topup-form input[name=amountUsd]").fill("25.00");
  await page.locator("#topup-form button[type=submit]").click();
  await page.getByRole("link", { name: "Pay with Solana wallet" }).waitFor();

  await page.getByLabel("Primary").getByRole("link", { name: "Create config" }).click();
  await page.locator("input[name=targetIp]").fill("1.1.1.1");
  await page.locator("select[name=ingressGateName]").selectOption("gate-eu-ams-21");
  await page.locator("select[name=egressGateName]").selectOption("gate-na-sjc-01");
  await page.locator("select[name=preferredRegion]").selectOption("na");
  await page.getByText("Excluded countries", { exact: true }).click();
  await page.locator('input[name=excludeCountry][value="Germany"]').check();
  await page.getByText("Excluded cities", { exact: true }).click();
  await page.locator('input[name=excludeCity][value="Frankfurt"]').check();
  await page.getByRole("button", { name: "Review config" }).click();
  await page.getByText(/Avoid countries: Germany/).waitFor();
  await page.getByRole("button", { name: "Confirm and create" }).click();

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
  if (!createdSessionPayload?.pathPolicy?.excludeCountries?.includes("Germany") ||
      !createdSessionPayload?.pathPolicy?.excludeCities?.includes("Frankfurt") ||
      !createdSessionPayload?.pathPolicy?.preferredRegions?.includes("na")) {
    throw new Error(`expected generalized routing policy, got ${JSON.stringify(createdSessionPayload)}`);
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
