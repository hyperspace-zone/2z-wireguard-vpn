import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright-core";
import { buildTradingPairsSnapshot, filterTradingPairs } from "../../packages/control-plane/dist/resources/trading-pairs/service.js";

const date = new Date().toISOString();
const venueNames = [["binance", "Binance", "cex"], ["hyperliquid", "Hyperliquid", "hyperliquid"], ["variational", "Variational Omni", "variational"], ["extended", "Extended", "extended"], ["rise", "RISEx", "rise"], ["lighter", "Lighter", "lighter"]];
const nodes = ["source", "egress"].map(id => ({ id, name: id, gateId: id, city: id === "source" ? "Frankfurt" : "Tokyo", country: id === "source" ? "Germany" : "Japan", provider: "Test fixture", regionCode: "TEST", latitude: 0, longitude: 0, fresh: true }));
const targets = venueNames.map(([key, displayName, category]) => ({ id: key, key, venueKey: key, category, displayName, product: "Perpetuals", protocol: "http_json", venueType: category === "cex" ? "cex" : "perpdex", revision: 1, intervalSeconds: 60, hostname: "example.invalid", path: "/test", measurement: "Public API RTT", sortOrder: 1 }));
const latency = { generatedAt: date, nodes, targets, measurements: nodes.flatMap(node => targets.map(target => ({ nodeId: node.id, targetId: target.id, targetRevision: 1, addressFamily: "ipv4", networkProfile: "direct", status: "succeeded", measuredAt: date, tcpMs: node.id === "source" ? 100 : 10, totalP50Ms: node.id === "source" ? 200 : 30, totalP95Ms: 250, sampleCount: 3, failureCount: 0 }))) };
const matrix = { generatedAt: date, gates: nodes.map(node => ({ id: node.id, name: `gate-${node.id}`, city: node.city, country: node.country, desiredState: "Enabled", publicIpv4: "8.8.8.8", ready: true, schedulable: true })), routes: [{ sourceGateId: "source", targetGateId: "egress", sourceGateName: "gate-source", targetGateName: "gate-egress", doublezero: { transport: "doublezero", status: "succeeded", sourceInterface: "doublezero0", lossPercent: 0, measuredAt: date, rttMs: { p50: 5 } }, public: { transport: "public", status: "succeeded", measuredAt: date, rttMs: { p50: 20 } } }] };
const snapshot = buildTradingPairsSnapshot(latency, matrix);
const requests = []; let postedSession; let rejectPreset = false; let acceptSession = false;
let pairFailuresRemaining = 0; let pairsUnavailable = false; let pairResponseState = "live";
const dist = resolve("apps/web/dist");
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost"); const path = url.pathname;
    requests.push(path);
    const json = (data, code = 200) => { response.writeHead(code, { "content-type": "application/json" }); response.end(JSON.stringify(data)); };
    if (path === "/api/v1/public/trading/pairs") {
      if (pairsUnavailable || pairFailuresRemaining > 0) { pairFailuresRemaining--; return json({ error: "synthetic_outage" }, 500); }
      return json(filterTradingPairs({ ...snapshot, generatedAt: new Date().toISOString(), snapshotStatus: pairResponseState }, { ...Object.fromEntries(url.searchParams), offset: Number(url.searchParams.get("offset") ?? 0), limit: Number(url.searchParams.get("limit") ?? 50) }));
    }
    if (path === "/api/v1/public/trading/latency") return json(latency);
    if (path.startsWith("/api/v1/public/trading/routes/")) {
      const row = snapshot.rows.find(row => row.id === path.split("/").at(-1) && row.configEligible);
      if (!row || rejectPreset) return json({ error: "trading_route_unavailable" }, 409);
      return json({ route: row, source: nodes[0], egress: nodes[1], venues: targets.filter(target => [row.venueAId, row.venueBId].includes(target.id)), warning: "Estimated only. Not measured from your server. FullTunnel routes all IPv4." });
    }
    if (path === "/api/v1/public/gates") return json({ gates: matrix.gates });
    if (path === "/api/v1/public/benchmarks/gate-matrix") return json(matrix);
    if (path === "/api/v1/public/auth/me") return json({ user: { id: "ui-test-user", accountId: "ui-test-account", email: "test@example.invalid", createdAt: date }, capabilities: [] });
    if (path === "/api/v1/public/auth/email/verify") return json({ accessToken: "ui-fixture-only" });
    if (path === "/api/v1/public/billing") return json({ configPriceBaseUnits: "100000000", configTrafficLimitBytes: "50000000000", asset: { symbol: "SOL", decimals: 9 }, balanceMinor: 0, configPayments: [], deposits: [], payments: [], withdrawals: [], plans: [], wallet: null });
    if (path === "/api/v1/public/sessions") {
      if (request.method === "POST") { let body = ""; for await (const chunk of request) body += chunk; postedSession = JSON.parse(body); if (acceptSession) return json({ session: { id: "26df9140-2f08-4c64-b270-429e4d74fb97", phase: "requested" } }, 201); return json({ error: "insufficient_solana_funds", message: "Synthetic payment failure; no funds used." }, 402); }
      return json({ sessions: [] });
    }
    if (path.startsWith("/api/")) return json({ error: "ui_fixture_not_implemented" }, 404);
    const file = path === "/" || path.startsWith("/trading/") || ["/login", "/create-config", "/benchmarks", "/billing"].includes(path) ? "index.html" : path.slice(1);
    const full = resolve(dist, file); if (!full.startsWith(`${dist}/`)) return json({}, 403);
    response.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" })[extname(file)] ?? "application/octet-stream"); response.end(await readFile(full));
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const local = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/snap/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route("**/*", route => route.request().url().startsWith(local) ? route.continue() : route.abort());
  const page = await context.newPage(); const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${local}/trading/pairs`); await page.locator(".pairs-data-row").first().waitFor();
  assert.equal(await page.locator(".pairs-data-row").count(), 15);
  await page.locator("[data-expand]").first().click(); await page.getByRole("link", { name: "Configure this route" }).waitFor();
  const routeUrl = await page.getByRole("link", { name: "Configure this route" }).getAttribute("href");
  if (process.env.TRADING_UI_SCREENSHOT) await page.screenshot({ path: process.env.TRADING_UI_SCREENSHOT, fullPage: true });
  await page.locator('select[name="kind"]').selectOption("cex-perpdex"); await page.getByRole("button", { name: "Apply filters" }).click(); await page.waitForFunction(() => document.querySelectorAll(".pairs-data-row").length === 5);
  await page.locator('select[name="evidence"]').selectOption("measured"); await page.getByRole("button", { name: "Apply filters" }).click(); await page.getByRole("heading", { name: "No VPN A/B verified routes yet" }).waitFor();
  await page.locator("#pairs-reset").click(); await page.locator(".pairs-data-row").first().waitFor();
  await page.getByRole("button", { name: "Venue matrix", exact: true }).click(); await page.locator(".pairs-matrix").waitFor(); assert.equal(await page.locator(".pairs-matrix thead th").count(), 7);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.goto(`${local}/trading/routes`); await page.locator(".pairs-data-row").first().waitFor(); assert.ok(page.url().includes("/trading/pairs"));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  for (const [key, name] of venueNames.slice(2)) { await page.goto(`${local}/trading/${key}`); await page.getByRole("heading", { name: `${name} Perpetuals` }).waitFor(); assert.equal(await page.locator("#trading-map").count(), 1); }
  await page.goto(`${local}${routeUrl}`); await page.getByRole("heading", { name: "Log in", exact: true }).waitFor();
  assert.ok(await page.evaluate(() => sessionStorage.getItem("hyperspaceTradingRoute")));
  await page.evaluate(() => localStorage.setItem("hyperspaceAccessToken", "ui-fixture-only"));
  await page.reload();
  try { await page.locator("#session-form").waitFor({ timeout: 8000 }); }
  catch (error) { console.error(JSON.stringify({ errors, body: (await page.locator("body").innerText()).slice(0,4000), requests: requests.slice(-20) })); throw error; }
  assert.equal(await page.locator('select[name="ingressGateName"]').inputValue(), "gate-source"); assert.equal(await page.locator('select[name="egressGateName"]').inputValue(), "gate-egress");
  await page.getByRole("button", { name: "Review config", exact: true }).click(); await page.locator("#confirm-create-config").waitFor();
  await page.locator("#confirm-create-config").click(); await page.waitForFunction(() => document.body.textContent.includes("Insufficient spendable SOL"));
  assert.equal(postedSession.tradingRouteId, routeUrl.split("=")[1]); assert.equal(postedSession.mode, "FullTunnel"); assert.equal(postedSession.ingressGateName, "gate-source"); assert.equal(postedSession.egressGateName, "gate-egress");
  rejectPreset = true; await page.goto(`${local}${routeUrl}`); await page.getByText("This route is no longer eligible.", { exact: false }).waitFor(); assert.equal(await page.locator("#session-form").count(), 0);
  await page.locator("#detach-trading-route").click(); await page.locator("#session-form").waitFor();
  const before = requests.filter(path => path.includes("gate-matrix")).length;
  await page.goto(`${local}/`); await page.locator(".shell").waitFor(); assert.equal(requests.filter(path => path.includes("gate-matrix")).length, before);
  await page.goto(`${local}/benchmarks`); await page.getByRole("heading", { name: "Benchmarks", exact: true }).waitFor(); assert.ok(requests.filter(path => path.includes("gate-matrix")).length > before);
  rejectPreset = false; acceptSession = true;
  await page.goto(`${local}${routeUrl}`); await page.locator("#session-form").waitFor();
  await page.getByRole("button", { name: "Review config", exact: true }).click(); await page.locator("#confirm-create-config").click();
  await page.waitForFunction(() => document.body.textContent.includes("VPN config requested."));
  assert.equal(await page.evaluate(() => sessionStorage.getItem("hyperspaceTradingRoute")), null);
  assert.equal(new URL(page.url()).searchParams.has("tradingRoute"), false);
  await page.locator('a[data-view="dashboard"]').first().click();
  await page.locator('a[data-view="create-config"]').first().click(); await page.locator("#session-form").waitFor();
  assert.equal(await page.locator(".pairs-checkout-notice").count(), 0, "A completed preset must not constrain the next manual config");
  pairFailuresRemaining = 1;
  await page.goto(`${local}/trading/pairs`);
  await page.getByText("Connecting to live measurements", { exact: false }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Pair Routes temporarily unavailable" }).count(), 0);
  await page.locator(".pairs-data-row").first().waitFor({ timeout: 5000 });
  assert.equal(await page.locator(".pairs-data-row").count(), 15, "First transient 500 must recover automatically");
  await page.locator("[data-expand]").first().click();
  await page.getByRole("link", { name: "Configure this route" }).waitFor();
  pairsUnavailable = true;
  await page.locator('input[name="search"]').fill("Tokyo");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.getByText("The requested filters have not loaded", { exact: false }).waitFor();
  assert.equal(await page.locator(".pairs-data-row").count(), 15);
  assert.equal(await page.locator(".pairs-detail").count(), 1, "Do not destroy the expanded comparison");
  assert.equal(await page.locator('input[name="search"]').inputValue(), "Tokyo", "Do not erase the requested input on a failed refresh");
  assert.equal(await page.getByRole("link", { name: "Configure this route" }).count(), 0);
  pairsUnavailable = false;
  await page.getByRole("button", { name: "Retry now" }).click();
  await page.getByRole("heading", { name: "No routes match these filters" }).waitFor();
  await page.locator("#pairs-reset").click(); await page.locator(".pairs-data-row").first().waitFor();
  pairResponseState = "stale";
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.getByText("Live refresh is delayed", { exact: false }).waitFor();
  if (await page.getByRole("link", { name: "Configure this route" }).count()) throw new Error("Stale server snapshots must not expose checkout");
  pairResponseState = "live";
  await page.getByRole("button", { name: "Retry now" }).click();
  await page.waitForFunction(() => document.querySelector("#pairs-refresh-status").hidden);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ["pair table", "pair type filters", "honest measured empty state", "venue matrix", "mobile overflow", "legacy alias", "four venue maps", "login intent", "exact config preset", "payment-error path", "stale preset blocks issuance", "manual detachment", "old dashboard", "benchmarks isolation", "successful issuance clears preset for the next config", "first-load 500 auto-recovery", "failed refresh retains table, detail and inputs", "stale snapshot blocks checkout", "fresh snapshot recovers the view"], fixture: true }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
