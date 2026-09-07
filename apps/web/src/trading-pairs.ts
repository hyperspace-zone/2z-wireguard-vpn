import type { PublicTradingPairsResponse, TradingPairRow, TradingPairNode, PublicTradingLatencyResponse } from "@hyperspace-zone/contracts";

type Venue = PublicTradingLatencyResponse["targets"][number];
type Measurement = PublicTradingLatencyResponse["measurements"][number];
let payload: PublicTradingPairsResponse | null = null;
let timer: number | undefined;
let controller: AbortController | undefined;
let requestGeneration = 0;
const expanded = new Set<string>();
let paused = false;
const queryKeys = ["a", "b", "source", "search", "kind", "evidence", "positive", "noRegression", "group", "sort", "offset"];

export function isTradingPairsPath(path: string): boolean {
  return /^\/trading\/(pairs|routes)(\/|$)/.test(path);
}

export function pairMeasurementFresh(node: { fresh: boolean }, venue: Venue, measurement: Measurement | undefined, now = Date.now()): boolean {
  if (!node.fresh || !measurement || measurement.status !== "succeeded") return false;
  const age = now - Date.parse(measurement.measuredAt);
  return Number.isFinite(age) && age >= -5000 && age <= Math.max(90, 3 * (venue.intervalSeconds ?? 30)) * 1000
    && measurement.targetRevision === venue.revision;
}

export function pairConfigUrl(id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid route ID");
  return `/create-config?tradingRoute=${id}`;
}

export function startTradingPairsApp(root: HTMLElement): void {
  document.title = "Pair Routes · Hyperspace";
  if (window.location.pathname.startsWith("/trading/routes")) window.history.replaceState({}, "", `/trading/pairs${window.location.search}`);
  root.innerHTML = `${navigation()}<main class="pairs-shell"><p class="pairs-notice">Loading venue routes…</p></main>`;
  window.addEventListener("popstate", () => void refresh(root));
  document.addEventListener("visibilitychange", () => {
    window.clearTimeout(timer);
    if (!document.hidden && !paused) void refresh(root);
  });
  void refresh(root);
}

async function refresh(root: HTMLElement): Promise<void> {
  window.clearTimeout(timer);
  controller?.abort();
  controller = new AbortController();
  const activeController = controller;
  const generation = ++requestGeneration;
  const timeout = window.setTimeout(() => activeController.abort(), 15000);
  try {
    const params = currentParams();
    const apiParams = new URLSearchParams();
    for (const key of queryKeys) if (params.has(key)) apiParams.set(key, params.get(key)!);
    apiParams.set("limit", "50");
    const response = await fetch(`/api/v1/public/trading/pairs?${apiParams}`, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Pair Routes API returned HTTP ${response.status}`);
    const next = await response.json() as PublicTradingPairsResponse;
    if (generation !== requestGeneration) return;
    payload = next;
    render(root);
  } catch (error) {
    if (generation !== requestGeneration) return;
    root.innerHTML = `${navigation()}<main class="pairs-shell"><h1>Pair Routes temporarily unavailable</h1><p>${escape(error instanceof Error ? error.message : "Could not load measurements")}</p><p><a href="/trading/cex">Open the latency map</a> · <a href="/benchmarks">Gate benchmarks</a></p><button id="pairs-retry">Retry</button></main>`;
    root.querySelector("#pairs-retry")?.addEventListener("click", () => void refresh(root));
  } finally {
    window.clearTimeout(timeout);
    if (generation === requestGeneration) scheduleRefresh(root);
  }
}

function scheduleRefresh(root: HTMLElement): void {
  if (document.hidden || paused) return;
  timer = window.setTimeout(() => {
    if (root.querySelector("#pairs-filters")?.contains(document.activeElement)) scheduleRefresh(root);
    else void refresh(root);
  }, 15000);
}

function render(root: HTMLElement): void {
  if (!payload) return;
  const params = currentParams(); const matrix = params.get("view") === "matrix";
  const source = payload.nodes.find(node => node.id === params.get("source"));
  root.innerHTML = `${navigation()}
    <main class="pairs-shell">
      <header class="pairs-hero"><div><div class="pairs-eyebrow">NETWORK INTELLIGENCE · POWERED BY DOUBLEZERO</div><h1>Pair Routes<span class="pairs-beta">BETA</span></h1><p>Two venues. One trading server. Find a better network path.</p></div>
        <div class="pairs-live"><span class="pairs-live-dot"></span> ${payload.summary.freshNodes}/${payload.nodes.length} probes online <small>Snapshot ${escape(new Date(payload.generatedAt).toLocaleTimeString())}</small><button id="pairs-pause" class="pairs-text-button">${paused ? "Resume updates" : "Pause updates"}</button></div></header>
      <div class="pairs-stats"><div><span>Tracked venues</span><strong>${payload.venues.length}</strong></div><div><span>Probe locations</span><strong>${payload.nodes.length}</strong></div><div><span>Estimated improvements · all pairs</span><strong>${payload.summary.estimatedImprovements}</strong></div><div><span>VPN A/B verified routes</span><strong>Not measured yet</strong></div></div>
      <div class="pairs-notice"><strong>Estimated network paths, not trading signals.</strong> We combine measured TCP connection times with measured DoubleZero gate RTT. WireGuard overhead and your server’s access path are not included. These are not measured VPN improvements, order latency or profit estimates. <a href="#pairs-methodology">How it works ↓</a></div>
      ${filters(payload, params)}
      <div class="pairs-toolbar"><div class="pairs-tabs"><button data-pairs-view="pairs" class="${!matrix ? "selected" : ""}">Pair opportunities</button><button data-pairs-view="matrix" class="${matrix ? "selected" : ""}">Venue matrix</button></div><span>${source ? `From ${escape(location(source))}` : params.get("group") === "all" ? "All probe locations" : "Best matching location per pair"}</span><button id="pairs-share" class="pairs-text-button">Copy view link</button></div>
      ${matrix ? matrixView(payload, params) : tableView(payload)}
      ${methodology()}
    </main>`;
  bind(root);
}

function navigation(): string {
  return `<nav class="pairs-nav" aria-label="Hyperspace navigation"><a class="pairs-brand" href="/trading/pairs"><img src="/hyperspace-logo.svg" alt=""/>Hyperspace</a><div><a href="/trading/pairs" class="active">Pair Routes</a><a href="/trading/cex">Latency map</a><a href="/benchmarks">Gate benchmarks</a></div><a href="/">VPN App ↗</a></nav>`;
}

function filters(data: PublicTradingPairsResponse, params: URLSearchParams): string {
  const options = (entries: Array<[string, string]>, selected: string) => entries.map(([value, label]) => `<option value="${escape(value)}" ${selected === value ? "selected" : ""}>${escape(label)}</option>`).join("");
  return `<form id="pairs-filters" class="pairs-filters">
    <div class="pairs-filter-main">${venuePicker("a", "Venue group A", data.venues, params)}<span class="pairs-cross">↔</span>${venuePicker("b", "Venue group B", data.venues, params)}
    <label>Trading server / probe<select name="source">${options([["all", "Explore all locations"], ...data.nodes.map(node => [node.id, `${location(node)}${!node.fresh ? " · offline" : ""}`] as [string, string])], params.get("source") ?? "all")}</select></label>
    <label>Pair type<select name="kind">${options([["all", "All venue pairs"], ["cex-perpdex", "CEX ↔ perpDEX"], ["perpdex-perpdex", "perpDEX ↔ perpDEX"], ["cex-cex", "CEX ↔ CEX"], ["prediction", "Prediction venues"]], params.get("kind") ?? "all")}</select></label></div>
    <div class="pairs-filter-secondary"><label>Search<input name="search" value="${escape(params.get("search") ?? "")}" placeholder="Venue, city, provider…" maxlength="100"/></label>
    <label>Evidence<select name="evidence">${options([["estimated", "Estimated paths"], ["measured", "VPN A/B verified only"]], params.get("evidence") ?? "estimated")}</select></label>
    <label>Sort by<select name="sort">${options([["saved", "Estimated saving · ms"], ["percent", "Estimated saving · %"], ["latency", "Lowest estimated pair RTT"], ["pair", "Venue pair"]], params.get("sort") ?? "saved")}</select></label>
    <label>Locations<select name="group">${options([["best", "Best per pair"], ["all", "Every location"]], params.get("group") ?? "best")}</select></label>
    <label class="pairs-check"><input type="checkbox" name="positive" ${params.get("positive") !== "false" ? "checked" : ""}/>Positive saving</label>
    <label class="pairs-check"><input type="checkbox" name="noRegression" ${params.get("noRegression") !== "false" ? "checked" : ""}/>Neither leg slower</label>
    <button type="submit" class="pairs-primary">Apply filters</button><button type="button" id="pairs-reset" class="pairs-text-button">Reset</button></div>
  </form>`;
}

function venuePicker(name: string, label: string, venues: Venue[], params: URLSearchParams): string {
  const selected = new Set((params.get(name) ?? "").split(",").filter(Boolean));
  return `<details class="pairs-venue-picker"><summary><span>${label}</span><strong>${selected.size ? `${selected.size} selected` : "All venues"}⌄</strong></summary><div>${venues.map(venue => `<label><input type="checkbox" name="${name}" value="${escape(venue.venueKey ?? "")}" ${selected.has(venue.venueKey ?? "") ? "checked" : ""}/><span>${escape(venue.displayName)}</span><small>${escape(venue.venueType ?? "")}</small></label>`).join("")}</div></details>`;
}

function tableView(data: PublicTradingPairsResponse): string {
  if (!data.rows.length) return `<section class="pairs-empty"><h2>${currentParams().get("evidence") === "measured" ? "No VPN A/B verified routes yet" : "No routes match these filters"}</h2><p>${currentParams().get("evidence") === "measured" ? "We will not label a calculated path as a measured VPN improvement. Explore estimates or compare current direct API access in the venue matrix." : "Try other venues or locations, or disable “Positive saving” to inspect unavailable and slower paths. No data does not mean zero latency."}</p><button data-pairs-view="matrix" class="pairs-primary">Open venue matrix</button></section>`;
  return `<section class="pairs-table-panel"><div class="pairs-table-scroll"><table class="pairs-table"><thead><tr><th>Venue pair</th><th>Trading server / probe</th><th>Venue A <small>Direct → est. HS</small></th><th>Venue B <small>Direct → est. HS</small></th><th>Pair index <small>Direct → est. HS</small></th><th>Estimated saving</th><th>Path / evidence</th><th></th></tr></thead><tbody>${data.rows.map(row => {
    const a = data.venues.find(venue => venue.id === row.venueAId)!; const b = data.venues.find(venue => venue.id === row.venueBId)!;
    const source = data.nodes.find(node => node.id === row.sourceNodeId)!; const egress = data.nodes.find(node => node.id === row.egressNodeId);
    return `<tr class="pairs-data-row" data-route-id="${row.id}"><td><div class="pairs-venue-name">${badge(a)}<a href="/trading/${escape(a.category)}?target=${encodeURIComponent(a.key)}">${escape(a.displayName)}</a></div><div class="pairs-venue-name">${badge(b)}<a href="/trading/${escape(b.category)}?target=${encodeURIComponent(b.key)}">${escape(b.displayName)}</a></div></td>
    <td><strong>${escape(source.city)}</strong><small>${escape(source.provider || source.regionCode)} · ${escape(source.country)}</small></td>
    <td>${comparison(row.legA.directMs, row.legA.estimatedMs)}</td><td>${comparison(row.legB.directMs, row.legB.estimatedMs)}</td><td>${comparison(row.directIndexMs, row.estimatedIndexMs)}</td>
    <td><strong class="${(row.savedMs ?? 0) > 0 ? "pairs-saving" : "pairs-negative"}">${ms(row.savedMs)}</strong><small>${row.savedPercent !== undefined ? `${row.savedPercent.toFixed(1)}%` : "—"}</small></td>
    <td><span class="pairs-evidence ${row.status}">${statusLabel(row.status)}</span><small>${egress ? `via ${escape(egress.city)} · ${ago(row.measuredAt)}` : "No eligible route"}</small></td>
    <td><button class="pairs-row-action" data-expand="${row.id}" aria-expanded="${expanded.has(row.id)}">${expanded.has(row.id) ? "Close ↑" : "Compare ↗"}</button></td></tr>
    ${expanded.has(row.id) ? `<tr class="pairs-details-row"><td colspan="8">${detail(row, a, b, source, egress)}</td></tr>` : ""}`;
  }).join("")}</tbody></table></div><footer class="pairs-pagination"><span>${data.offset + 1}–${data.offset + data.rows.length} of ${data.total} matching routes</span><div><button data-page="${Math.max(0, data.offset - data.limit)}" ${data.offset === 0 ? "disabled" : ""}>← Previous</button><button data-page="${data.offset + data.limit}" ${data.offset + data.limit >= data.total ? "disabled" : ""}>Next →</button></div></footer></section>`;
}

function detail(row: TradingPairRow, a: Venue, b: Venue, source: TradingPairNode, egress: TradingPairNode | undefined): string {
  const scale = Math.max(row.legA.directMs ?? 0, row.legA.estimatedMs ?? 0, row.legB.directMs ?? 0, row.legB.estimatedMs ?? 0, 1);
  const leg = (venue: Venue, metrics: TradingPairRow["legA"]) => `<section><h3>${escape(venue.displayName)}</h3><p class="pairs-endpoint">${escape(venue.hostname ?? "")}<wbr>${escape(venue.path ?? "")}</p><div class="pairs-bar-line"><span>Direct TCP</span><div><i style="width:${Math.max(1, (metrics.directMs ?? 0) / scale * 100)}%"></i></div><b>${ms(metrics.directMs)}</b></div><div class="pairs-bar-line estimated"><span>Est. HS TCP</span><div><i style="width:${Math.max(1, (metrics.estimatedMs ?? 0) / scale * 100)}%"></i></div><b>${ms(metrics.estimatedMs)}</b></div><dl><dt>Direct API p50 / p95</dt><dd>${ms(metrics.directApiP50Ms)} / ${ms(metrics.directApiP95Ms)}</dd><dt>Direct sample / failures</dt><dd>${metrics.sampleCount ?? "—"} / ${metrics.failureCount ?? "—"}</dd><dt>Egress → venue TCP</dt><dd>${ms(metrics.egressTcpMs)}</dd></dl></section>`;
  return `<div class="pairs-detail"><div class="pairs-detail-heading"><div><strong>${escape(location(source))} → DoubleZero → ${escape(egress ? location(egress) : "No egress")} → both venues</strong><p>One shared egress. Source remains fixed for the direct and estimated paths.</p></div><span class="pairs-evidence">Estimated · not A/B verified</span></div>
    <div class="pairs-legs">${leg(a, row.legA)}${leg(b, row.legB)}</div>
    <p>${escape(row.reason)}</p>
    ${row.backboneRttMs !== undefined ? `<div class="pairs-backbone"><strong>Measured gate transport</strong><span>Internet ${ms(row.publicBackboneRttMs)}</span><span>DoubleZero ${ms(row.backboneRttMs)}</span><span>Gate RTT saving ${ms(row.backboneSavedMs)}</span><span>Loss ${row.backboneLossPercent ?? "—"}%</span><small>${ago(row.backboneMeasuredAt)}</small></div>` : ""}
    <div class="pairs-detail-actions"><div><strong>Check this route with your own trading server</strong><p>Gate estimates exclude your server → ingress link and VPN overhead. FullTunnel covers all IPv4 traffic in the chosen network namespace, not only these venues. Do not change a live trading host’s default route without an isolated test.</p></div>${row.configEligible ? `<a class="pairs-primary" href="${pairConfigUrl(row.id)}">Configure this route →</a>` : '<span class="pairs-muted">No recommended config for this result</span>'}</div>
    <p class="pairs-footnote">Already have a config? Use the <a href="/trading-pair-check.mjs" download>read-only comparison tool</a> to record direct and VPN results in your own network namespace. No exchange keys or orders. <code>node trading-pair-check.mjs --help</code></p></div>`;
}

function matrixView(data: PublicTradingPairsResponse, params: URLSearchParams): string {
  const selected = new Set([...(params.get("a") ?? "").split(","), ...(params.get("b") ?? "").split(",")].filter(Boolean));
  const venues = data.venues.filter(venue => !selected.size || selected.has(venue.venueKey ?? ""));
  const nodes = data.nodes.filter(node => !params.get("source") || params.get("source") === "all" || params.get("source") === node.id);
  const api = params.get("metric") === "api";
  return `<section class="pairs-table-panel"><div class="pairs-matrix-heading"><div><strong>Direct public-path measurements</strong><p>All selected venues at once. Different public APIs are not interchangeable trading workloads.</p></div><div class="pairs-tabs"><button data-metric="tcp" class="${!api ? "selected" : ""}">TCP connect</button><button data-metric="api" class="${api ? "selected" : ""}">Cold API p50</button></div></div><div class="pairs-table-scroll"><table class="pairs-table pairs-matrix"><thead><tr><th>Probe location</th>${venues.map(venue => `<th>${escape(venue.displayName)}<small>${escape(venue.product)}</small></th>`).join("")}</tr></thead><tbody>${nodes.map(node => `<tr><th>${escape(node.city)}<small>${escape(node.provider || node.regionCode)} · ${node.fresh ? "online" : "offline"}</small></th>${venues.map(venue => {
    const measurement = data.matrix.find(m => m.nodeId === node.id && m.targetId === venue.id);
    const fresh = pairMeasurementFresh(node, venue, measurement); const value = fresh ? api ? measurement?.totalP50Ms : measurement?.tcpMs : undefined;
    const status = fresh ? measurement?.failureCount ? `${measurement.failureCount}/${measurement.sampleCount} failed` : ago(measurement?.measuredAt) : measurement?.status === "failed" ? measurement.errorCode ?? "Failed" : measurement ? "Stale / offline" : "Waiting";
    return `<td class="${value !== undefined && value < 50 ? "pairs-matrix-fast" : ""}"><a href="/trading/${escape(venue.category)}?target=${encodeURIComponent(venue.key)}"><strong>${ms(value)}</strong><small>${escape(status)}${measurement?.addressFamily === "ipv6" ? " · IPv6" : ""}</small></a></td>`;
  }).join("")}</tr>`).join("")}</tbody></table></div></section>`;
}

function methodology(): string {
  return `<details id="pairs-methodology" class="pairs-methodology"><summary>Methodology, limitations & choosing a config</summary><div><h2>What is ranked?</h2><p>The sum of two TCP connection RTT estimates from a fixed source gate. Estimated leg = measured DoubleZero ingress→egress RTT + measured egress→venue TCP connect time. Estimated saving = direct pair index − estimated pair index. This is an additive network proxy, not a measured VPN round trip or the duration of an arbitrage cycle.</p><h3>Measured versus estimated</h3><p>The existing fleet measures direct public API access and gate-to-gate transport. It does not yet collect end-to-end venue requests through your WireGuard config. No row is labelled VPN A/B verified. The measured Internet/DoubleZero comparison inside a row concerns only the gate-to-gate segment. Cold API p50/p95 are shown separately and are never added to gate RTT or presented as order execution latency.</p><h3>Quality gates</h3><p>Both legs require fresh, successful samples of the same target revision, complete sample batches, matching time windows, schedulable gates and a fresh loss-free DoubleZero gate measurement. Same-metro DoubleZero N/A is excluded. The default filters exclude non-positive savings and a slower second leg. Estimates do not establish p95 improvement or long-term stability.</p><h3>Your server is not our probe</h3><p>Provider, source IP, DNS/CDN routing and the access link can change the result. Use a separate network namespace to compare your existing config with direct access. We never place orders or need exchange keys. Regional restrictions still apply.</p><h3>One shared exit</h3><p>Configure this route carries the selected ingress/egress into the existing VPN purchase flow, which revalidates the route before a new charge. The first version uses FullTunnel with one shared egress for both venues. Multi-egress and venue-only DNS routing are not implied.</p></div></details>`;
}

function bind(root: HTMLElement): void {
  root.querySelector<HTMLFormElement>("#pairs-filters")?.addEventListener("submit", event => {
    event.preventDefault(); const form = new FormData(event.currentTarget as HTMLFormElement); const params = currentParams();
    for (const key of ["a", "b"]) { const values = form.getAll(key).map(String).filter(Boolean); if (values.length) params.set(key, values.join(",")); else params.delete(key); }
    for (const key of ["source", "kind", "search", "evidence", "sort", "group"]) { const value = String(form.get(key) ?? ""); if (value) params.set(key, value); else params.delete(key); }
    params.set("positive", String(form.has("positive"))); params.set("noRegression", String(form.has("noRegression"))); params.delete("offset"); navigate(root, params);
  });
  root.querySelector("#pairs-reset")?.addEventListener("click", () => navigate(root, new URLSearchParams()));
  root.querySelector("#pairs-pause")?.addEventListener("click", () => { paused = !paused; window.clearTimeout(timer); render(root); if (!paused) void refresh(root); });
  root.querySelectorAll<HTMLElement>("[data-pairs-view]").forEach(button => button.addEventListener("click", () => { const params = currentParams(); params.set("view", button.dataset.pairsView!); navigate(root, params); }));
  root.querySelectorAll<HTMLElement>("[data-metric]").forEach(button => button.addEventListener("click", () => { const params = currentParams(); params.set("metric", button.dataset.metric!); navigate(root, params); }));
  root.querySelectorAll<HTMLElement>("[data-expand]").forEach(button => button.addEventListener("click", () => { const id = button.dataset.expand!; if (expanded.has(id)) expanded.delete(id); else expanded.add(id); render(root); }));
  root.querySelectorAll<HTMLElement>("[data-page]").forEach(button => button.addEventListener("click", () => { const params = currentParams(); params.set("offset", button.dataset.page!); navigate(root, params); }));
  root.querySelector("#pairs-share")?.addEventListener("click", async event => { try { await navigator.clipboard.writeText(window.location.href); (event.target as HTMLElement).textContent = "Link copied"; } catch { (event.target as HTMLElement).textContent = "Copy this page’s address"; } });
}

function navigate(root: HTMLElement, params: URLSearchParams): void { window.history.pushState({}, "", `/trading/pairs${params.size ? `?${params}` : ""}`); void refresh(root); }
function currentParams(): URLSearchParams { return new URLSearchParams(window.location.search); }
function escape(value: string): string { return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
function ms(value: number | undefined): string { return value !== undefined && Number.isFinite(value) ? `${value.toFixed(2)} ms` : "—"; }
function location(node: TradingPairNode): string { return `${node.city} / ${node.provider || node.regionCode || node.name}`; }
function ago(value: string | undefined): string { if (!value) return "No measurement"; const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000)); return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`; }
function comparison(direct: number | undefined, estimated: number | undefined): string { return `<span class="pairs-before">${ms(direct)}</span><strong class="pairs-after">→ ${ms(estimated)}</strong>`; }
function badge(venue: Venue): string { return `<span class="pairs-venue-badge ${escape(venue.venueType ?? "")}" aria-hidden="true">${escape(venue.displayName.slice(0, 1))}</span>`; }
function statusLabel(status: TradingPairRow["status"]): string { return ({ estimated: "Estimated", regression: "One leg slower", no_improvement: "No improvement", unavailable: "Unavailable", stale: "Stale" })[status]; }
