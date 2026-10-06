// Browser checks against local dist or HYPERSPACE_WEB_URL. API data is fixture-only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright-core";

const dist = resolve("apps/web/dist");
const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const file = resolve(dist, path === "/" ? "./index.html" : `.${path}`);
  if (!file.startsWith(dist + "/")) { res.writeHead(400); res.end(); return; }
  try {
    const content = await readFile(file);
    res.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" }); res.end(content);
  } catch {
    if (path.startsWith("/assets/")) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html" }); res.end(await readFile(resolve(dist, "index.html")));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = process.env.HYPERSPACE_WEB_URL ?? `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/snap/bin/chromium", headless: true, args: ["--no-sandbox"] });
const billing = {
  accountId: "0170d686-35ec-4f8d-99c6-e6aae22007d3", balanceMinor: 1234, availableBalanceMinor: 1234,
  currency: "USD", ledger: [], deposit: null, deposits: [], buckets: {},
  state: { state: "active" }, plan: { displayName: "Fixture", version: 1 },
  usage: [], withdrawals: [], walletBalanceBaseUnits: null, walletSpendableBaseUnits: null,
  walletRentReserveBaseUnits: null, configPriceBaseUnits: "100000"
};

async function fixturePage(deferWallet = false) {
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem("hyperspaceAccessToken", "fixture-token"));
  const calls = [];
  let release;
  const pendingBilling = new Promise((r) => { release = r; });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    let json;
    if (path === "/api/v1/public/gates") json = { gates: [] };
    else if (path === "/api/v1/public/sessions") json = { sessions: [] };
    else if (path === "/api/v1/public/auth/me") json = {
      user: { accountId: billing.accountId, email: "fixture@example.invalid", displayName: "Fixture Admin" },
      capabilities: ["billing:admin"]
    };
    else if (path === "/api/v1/public/billing") {
      if (deferWallet) json = { ...billing, currency: "SOL", walletBalanceStatus: "loading",
        deposit: { chain: "solana", address: "11111111111111111111111111111111", tokenSymbol: "SOL", tokenMint: "native", tokenDecimals: 9, qrSvg: "<svg></svg>" } };
      else { await pendingBilling; json = billing; }
    }
    else if (path === "/api/v1/public/billing/wallet-balance") {
      await pendingBilling; json = { walletBalanceStatus: "available", walletBalanceBaseUnits: "5000000",
        walletSpendableBaseUnits: "4000000", walletRentReserveBaseUnits: "1000000" };
    }
    else if (path === "/api/v1/admin/billing/customers") json = {
      customers: [], customerCount: 3054, configs: [], payments: [], deposits: [],
      treasury: { status: deferWallet ? "loading" : "not_configured", address: null, balanceBaseUnits: null },
      asset: { symbol: "SOL", decimals: 9, configPriceBaseUnits: "100000" }
    };
    else if (path === "/api/v1/admin/billing/treasury") { await pendingBilling; json = { status: "available", address: "fixture", balanceBaseUnits: "1000000" }; }
    else if (path === "/api/v1/admin/billing/traffic") json = { range: "24h", points: [], bucketSeconds: 900 };
    else json = {};
    await route.fulfill({ json }).catch(() => {});
  });
  return { page, calls, release };
}

try {
  const first = await fixturePage();
  const start = performance.now();
  await first.page.goto(base + "/");
  await first.page.locator('a[data-view="admin-billing"]').waitFor({ timeout: 3000 });
  const renderMs = Math.round(performance.now() - start);
  assert.equal(first.calls.some(p => p.includes("/admin/billing/")), false);
  assert.match(await first.page.locator(".identity-balance").innerText(), /Loading/);
  await first.page.locator('a[data-view="create-config"]').first().click();
  const field = first.page.locator('input[name="label"]');
  await field.evaluate(el => {
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
  });
  await field.fill("Keep this form");
  await field.focus();
  first.release();
  await first.page.waitForFunction(() => document.querySelector(".identity-balance strong")?.textContent?.includes("12.34"));
  assert.equal(await field.inputValue(), "Keep this form");
  assert.equal(await field.evaluate(el => el === document.activeElement), true);
  await first.page.locator('a[data-view="admin-billing"]').click();
  await first.page.waitForFunction(() => document.body.textContent.includes("Confirmed config revenue"));
  assert.match(await first.page.locator(".primary-panel").innerText(), /3054/);
  assert.equal(first.calls.includes("/api/v1/admin/billing/customers"), true);
  assert.equal(first.calls.includes("/api/v1/admin/billing/traffic"), true);
  console.log(JSON.stringify({ test: "dashboard renders before delayed billing; admin is lazy; form is preserved", renderMs, ok: true }));

  const second = await fixturePage();
  await second.page.goto(base + "/");
  await second.page.locator("#logout").waitFor();
  await second.page.locator("#logout").click();
  second.release();
  await second.page.waitForTimeout(150);
  assert.equal(await second.page.locator(".identity-balance").count(), 0);
  assert.equal(await second.page.locator("#logout").count(), 0);
  assert.equal(await second.page.evaluate(() => localStorage.getItem("hyperspaceAccessToken")), null);
  console.log(JSON.stringify({ test: "logout ignores a late balance response", ok: true }));

  const third = await fixturePage(true);
  await third.page.goto(base + "/billing");
  await third.page.locator("[data-copy-wallet]").waitFor({ timeout: 3000 });
  assert.match(await third.page.locator(".balance-value").innerText(), /Loading/);
  assert.equal(third.calls.includes("/api/v1/public/billing/wallet-balance"), true);
  await third.page.locator('a[data-view="admin-billing"]').click();
  await third.page.waitForFunction(() => document.body.textContent.includes("Confirmed config revenue"));
  assert.match(await third.page.locator(".primary-panel").innerText(), /Loading/);
  third.release();
  await third.page.waitForFunction(() => !document.body.textContent.includes("Loading…"));
  await third.page.locator('a[data-view="billing"]').first().click();
  await third.page.waitForFunction(() => document.querySelector(".balance-value")?.textContent?.includes("0.004"));
  console.log(JSON.stringify({ test: "Billing metadata and Admin inventory render before live balance RPC", ok: true }));

  const fourth = await fixturePage(true);
  await fourth.page.goto(base + "/billing");
  await fourth.page.locator("[data-copy-wallet]").waitFor();
  await fourth.page.locator("#logout").click();
  fourth.release();
  await fourth.page.waitForTimeout(150);
  assert.equal(await fourth.page.locator(".identity-balance").count(), 0);
  console.log(JSON.stringify({ test: "logout ignores a late separate wallet RPC", ok: true }));

  const anonymous = await browser.newPage();
  const publicCalls = [];
  await anonymous.route("**/api/**", route => {
    publicCalls.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { turnstile: { enabled: false } } });
  });
  await anonymous.goto(base + "/login");
  await anonymous.locator("#login-form").waitFor({ timeout: 3000 });
  assert.equal(publicCalls.includes("/api/v1/public/gates"), false);
  const resources = await anonymous.evaluate(() => performance.getEntriesByType("resource").map(r => r.name));
  assert.equal(resources.some(url => /\/(leaflet|trading|trading-pairs)\.(js|css)/.test(url)), false);
  console.log(JSON.stringify({ test: "anonymous login renders without catalog, Trading modules or Leaflet", ok: true }));

  const trading = await browser.newPage();
  const tradingCalls = [];
  await trading.route("https://tile.openstreetmap.org/**", route => route.abort());
  await trading.route("**/api/v1/public/trading/latency?**", route => {
    const params = new URL(route.request().url()).searchParams;
    tradingCalls.push(Object.fromEntries(params));
    return route.fulfill({ json: { generatedAt: new Date().toISOString(), nodes: [], measurements: [],
      targets: ["alpha", "beta"].map(key => ({ id: key, key, category: "cex", displayName: key,
        product: "Fixture", protocol: "http_json", measurement: "cold API", sortOrder: 1 })) } });
  });
  await trading.goto(base + "/trading/cex");
  await trading.locator("#trading-target-select").waitFor();
  await trading.locator("#trading-map .leaflet-pane").first().waitFor({ state: "attached", timeout: 3000 });
  assert.ok(await trading.locator("#trading-map").evaluate(el => el.getBoundingClientRect().height > 0));
  assert.deepEqual(tradingCalls[0], { category: "cex", target: "default" });
  await trading.locator("#trading-target-select").selectOption("beta");
  await trading.waitForFunction(() => document.querySelector(".trading-ranking-heading")?.textContent?.includes("beta"));
  assert.deepEqual(tradingCalls.at(-1), { category: "cex", target: "beta" });
  console.log(JSON.stringify({ test: "Trading loads map assets lazily and fetches new measurements after target selection", ok: true }));
} finally { await browser.close(); await new Promise(r => server.close(r)); }
