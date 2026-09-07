import assert from "node:assert/strict";
import { chromium } from "playwright-core";

// Read-only public acceptance checks. Never authenticate, fund or issue sessions.
const base = process.env.TRADING_SMOKE_URL ?? "https://app.staging.hyperspace.zone";
if (!["https://app.staging.hyperspace.zone", "https://app.hyperspace.zone"].includes(base)) throw new Error("Unsupported smoke environment");
const get = async path => { const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(20_000) }); assert.equal(response.status, 200, path); return response.json(); };
const latency = await get("/api/v1/public/trading/latency");
const pairs = await get("/api/v1/public/trading/pairs?limit=5");
assert.equal(latency.targets.length, 30);
assert.equal(pairs.venues.length, 17);
assert.equal(pairs.summary.verifiedRoutes, 0);
for (const row of pairs.rows) {
  for (const nodeId of [row.sourceNodeId, row.egressNodeId]) for (const targetId of [row.venueAId, row.venueBId]) {
    assert.equal(pairs.matrix.find(sample => sample.nodeId === nodeId && sample.targetId === targetId)?.addressFamily, "ipv4", "VPN presets must not be ranked with IPv6 or unknown-family measurements");
  }
}
for (const key of ["variational", "extended", "rise", "lighter"]) {
  const target = latency.targets.find(target => target.category === key);
  assert.ok(target, key);
  assert.ok(latency.measurements.some(row => row.targetId === target.id && row.targetRevision === target.revision && Date.now() - Date.parse(row.measuredAt) < 180_000), `${key} requires a fresh report (regional errors are valid reports)`);
}
const measured = await get("/api/v1/public/trading/pairs?evidence=measured");
assert.equal(measured.total, 0);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  let configIntentChecked = false;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().startsWith(`${base}/api/`) && !["GET", "HEAD", "OPTIONS"].includes(request.method())) errors.push(`Unexpected mutation: ${request.method()} ${request.url()}`); });
  await page.goto(`${base}/trading/pairs`);
  await page.getByRole("heading", { name: /Pair Routes/ }).waitFor();
  if (pairs.total > 0) {
    await page.locator("[data-expand]").first().click();
    const config = page.getByRole("link", { name: "Configure this route" });
    await config.waitFor();
    const url = await config.getAttribute("href");
    const preset = await get(`/api/v1/public/trading/routes/${url.split("=")[1]}`);
    assert.ok(preset.route.configEligible);
    assert.ok(preset.source.gateId && preset.egress.gateId);
    if (process.env.TRADING_UI_SCREENSHOT) await page.screenshot({ path: process.env.TRADING_UI_SCREENSHOT, fullPage: true });
    await config.click(); await page.getByRole("heading", { name: "Log in", exact: true }).waitFor();
    assert.ok(await page.evaluate(() => sessionStorage.getItem("hyperspaceTradingRoute")));
    configIntentChecked = true;
  }
  await page.goto(`${base}/trading/pairs?view=matrix`); await page.locator(".pairs-matrix").waitFor();
  assert.equal(await page.locator(".pairs-matrix thead th").count(), 18);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  for (const [key, title] of [["variational", "Variational Omni"], ["extended", "Extended"], ["rise", "RISEx"], ["lighter", "Lighter"], ["hyperliquid", "Hyperliquid"]]) {
    await page.goto(`${base}/trading/${key}`);
    await page.getByRole("heading", { name: new RegExp(title) }).waitFor();
    assert.equal(await page.locator("#trading-map.leaflet-container").count(), 1);
  }
  await page.goto(`${base}/trading/`); await page.locator("#trading-target-select").waitFor();
  assert.equal(await page.locator("#trading-target-select option").count(), 10);
  await page.goto(`${base}/benchmarks`); await page.getByRole("heading", { name: "Benchmarks", exact: true }).waitFor();
  await page.goto(`${base}/`); await page.getByRole("heading", { name: "Log in", exact: true }).waitFor();
  const client = await fetch(`${base}/trading-pair-check.mjs`); assert.equal(client.status, 200); assert.match(await client.text(), /network namespace/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, environment: base, targets: latency.targets.length, venues: pairs.venues.length, nodes: pairs.nodes.length, matchingRoutes: pairs.total, verifiedRoutes: 0, readOnly: true, configIntentChecked, ...(!configIntentChecked ? { skipped: "No currently eligible route; config intent is covered by the fixture suite." } : {}), checks: ["public API", "new venue reports", "pair view", "matrix", "mobile", "new and old maps", "benchmarks", "login", "client download"] }));
} finally { await browser.close(); }
