#!/usr/bin/env node
// Local built UI only. Every API request is mocked; no accounts or payments.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const dist = new URL("../../apps/web/dist/", import.meta.url);
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    const file = path.startsWith("/assets/") ? path.slice(1) : "index.html";
    res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    res.end(await readFile(new URL(file, dist)));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/snap/bin/chromium", headless: true, args: ["--no-sandbox"] });
  for (const admin of [false, true]) {
  for (const [search, expected] of [["", "wireguard"], ["?protocol=wireguard", "wireguard"], ["?protocol=amnezia", "amneziawg"], ["?protocol=typo", null]]) {
    const { context, page, requests, errors } = await setup(admin);
    await page.addInitScript(() => localStorage.setItem("hyperspaceAccessToken", "local-smoke-token"));
    await page.goto(base + "/create-config" + search);
    if (!expected) {
      await page.getByRole("alert").filter({ hasText: "Unknown VPN protocol" }).waitFor();
      assert.equal(await page.locator("#session-form").count(), 0);
      assert.equal(requests.length, 0);
    } else {
      await page.locator("#session-form").waitFor();
      assert.equal(await page.locator('[name="clientProtocol"], [name="protocol"]').count(), 0);
      await page.getByText("Optional settings", { exact: true }).click();
      const ingress = page.locator('[name="ingressGateName"]');
      const options = await ingress.locator("option").evaluateAll(nodes => nodes.map(n => n.value).filter(Boolean).sort());
      assert.deepEqual(options, expected === "amneziawg" ? ["b-awg"] : ["a-wg", "b-awg", "c-wg"]);
      await page.locator('[name="egressGateName"]').selectOption("c-wg");
      await page.getByRole("button", { name: "Review config", exact: true }).click();
      assert.equal((await page.locator("body").innerText()).includes("AmneziaWG"), expected === "amneziawg");
      assert.equal(await page.locator("#confirm-create-config").innerText(), admin ? "Create config for free" : "Pay 0.1 SOL and create");
      const paymentCopy = await page.locator(".config-payment-copy").innerText();
      assert.match(paymentCopy, /50\.00 GB/);
      assert.match(paymentCopy, admin ? /No wallet balance or network fee is required/ : /A Solana network fee is added/);
      await page.locator("#confirm-create-config").click();
      await page.locator("#download-created-config").waitFor();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].clientProtocol, expected);
      assert.equal(new URL(page.url()).search, expected === "amneziawg" ? "?protocol=amnezia" : "");
      assert.equal((await page.locator(".created-config-actions").innerText()).includes("AmneziaWG"), expected === "amneziawg");
      if (expected === "amneziawg") {
        // A regular create link resets to WG; Back restores the explicit URL.
        await page.locator('a[data-view="create-config"]').first().click();
        await page.locator("#session-form").waitFor();
        assert.equal(new URL(page.url()).search, "");
        assert.doesNotMatch(await page.locator("body").innerText(), /AmneziaWG/);
        await page.goBack();
        await page.locator("#session-form").waitFor();
        assert.equal(new URL(page.url()).search, "?protocol=amnezia");
        assert.match(await page.locator("body").innerText(), /AmneziaWG/);
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  }

  // Simulate a full OAuth redirect/reload; the browser storage survives it.
  const { context, page, errors } = await setup();
  await page.goto(base + "/create-config?protocol=amnezia");
  await page.waitForURL(base + "/login");
  await page.goto(base + "/login?oauth=callback#access_token=local-smoke-token");
  await page.waitForURL(base + "/create-config?protocol=amnezia");
  await page.locator("#session-form").waitFor();
  assert.match(await page.locator("body").innerText(), /AmneziaWG/);
  await page.goto(base + "/create-config");
  await page.locator("#session-form").waitFor();
  assert.doesNotMatch(await page.locator("body").innerText(), /AmneziaWG/);
  await page.goto(base + "/create-config?protocol=amnezia&tradingRoute=" + "a".repeat(64));
  await page.locator("#detach-trading-route").click();
  assert.equal(new URL(page.url()).search, "?protocol=amnezia");
  await page.reload();
  await page.locator("#session-form").waitFor();
  assert.match(await page.locator("body").innerText(), /AmneziaWG/);
  assert.deepEqual(errors, []);
  await context.close();
  console.log("PASS: both WireGuard profiles, paid/free issuance UI, invalid URL, gate filtering, request payload, result, navigation and OAuth return");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}

async function setup(admin = false) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const requests = [], errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const gates = ["a-wg", "b-awg", "c-wg"].map(name => ({ id: name, name, city: "Test", country: "Test", publicIpv4: "192.0.2.1", ready: true, schedulable: true, amneziaWGReady: name === "b-awg" }));
  const session = { id: "smoke", mode: "FullTunnel", desiredState: "Active", phase: "active", destinationCidrs: ["0.0.0.0/0"], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname;
    let body = {};
    if (path.endsWith("/auth/me")) body = { user: { id: "test", accountId: "test", email: "test@example.invalid" }, capabilities: admin ? ["billing:admin"] : [] };
    else if (path.endsWith("/billing")) body = { configPaymentExempt: admin, configPriceBaseUnits: admin ? "0" : "100000000", configTrafficLimitBytes: "50000000000", walletBalanceStatus: "available", walletSpendableBaseUnits: "0", deposit: { tokenDecimals: 9, tokenSymbol: "SOL" } };
    else if (path.endsWith("/billing/wallet-balance")) body = { walletBalanceStatus: "available", walletSpendableBaseUnits: "0" };
    else if (path.endsWith("/auth/security-config")) body = { turnstileEnabled: false, turnstileSiteKey: "" };
    else if (path.endsWith("/gates")) body = { gates };
    else if (path.includes("/trading/routes/")) body = { route: { ingressGateName: "b-awg", egressGateName: "c-wg" }, source: { city: "Test" }, venues: [] };
    else if (path.endsWith("/sessions")) {
      if (route.request().method() === "POST") { requests.push(route.request().postDataJSON()); body = { session }; }
      else body = { sessions: requests.length ? [session] : [] };
    } else if (path.endsWith("/download-token")) body = { downloadUrl: "/v1/public/downloads/smoke" };
    else if (path.endsWith("/downloads/smoke")) return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" />' });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return { context, page, requests, errors };
}
