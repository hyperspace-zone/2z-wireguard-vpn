#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const webDir = join(repoRoot, "apps/web");
const distDir = join(webDir, "dist");
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/snap/bin/chromium";
const headless = process.env.PLAYWRIGHT_HEADLESS !== "0";

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
let authenticated = false;
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
        email: "pilot@example.com",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        devCode: "123456"
      });
    }
    if (path === "/v1/public/auth/email/verify-code" && method === "POST") {
      authenticated = true;
      return json(route, {
        user: { id: "user-1", accountId: "account-1", email: "pilot@example.com", displayName: "Pilot" },
        accessToken: "test-token",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      });
    }
    if (path === "/v1/public/auth/me") {
      return okAuth
        ? json(route, { user: { id: "user-1", accountId: "account-1", email: "pilot@example.com", displayName: "Pilot" } })
        : json(route, { error: "auth_required" }, 401);
    }
    if (path === "/v1/public/billing") {
      return json(route, {
        accountId: "account-1",
        balanceMinor: 2500,
        currency: "USD",
        ledger: [],
        topups: []
      });
    }
    if (path === "/v1/public/auth/wallets") {
      return json(route, { wallets: [] });
    }
    if (path === "/v1/public/sessions" && method === "GET") {
      return json(route, { sessions: [] });
    }
    if (path === "/v1/public/sessions" && method === "POST") {
      createdSessionPayload = request.postDataJSON();
      return json(route, { session: { id: "session-1" } }, 201);
    }
    if (path === "/v1/public/network/me") {
      return json(route, { ip: "198.51.100.10" });
    }
    return json(route, { error: "not_mocked", path, method }, 404);
  });

  await page.goto(`${baseUrl}/login`);
  await page.locator("#email-code-request-form input[name=email]").fill("pilot@example.com");
  await page.locator("#email-code-request-form button[type=submit]").click();
  await page.locator("#email-code-verify-form input[name=code]").fill("123456");
  await page.locator("#email-code-verify-form button[type=submit]").click();

  await page.getByRole("heading", { name: "Account" }).waitFor();
  await page.getByText("$25.00").waitFor();

  await page.getByLabel("Primary").getByRole("link", { name: "Create config" }).click();
  await page.locator("input[name=targetIp]").fill("1.1.1.1");
  await page.locator("select[name=ingressGateName]").selectOption("gate-eu-ams-21");
  await page.locator("select[name=egressGateName]").selectOption("gate-na-sjc-01");
  await page.locator("input[name=avoidGermany]").check();
  await page.getByRole("button", { name: "Review config" }).click();
  await page.getByText("Avoid Germany").waitFor();
  await page.getByRole("button", { name: "Confirm and create" }).click();

  await page.waitForFunction(() => window.localStorage.getItem("hyperspaceAccessToken") === "test-token");
  if (!createdSessionPayload?.pathPolicy?.excludeCountries?.includes("Germany")) {
    throw new Error(`expected Avoid Germany pathPolicy, got ${JSON.stringify(createdSessionPayload)}`);
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
