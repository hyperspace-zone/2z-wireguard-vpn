interface TradingNode {
  id: string;
  name: string;
  city: string;
  country: string;
  latitude: number;
  longitude: number;
  provider: string;
  regionCode: string;
  fresh: boolean;
  lastSeenAt?: string;
}

interface TradingTarget {
  id: string;
  key: string;
  category: string;
  displayName: string;
  product: string;
  protocol: string;
  measurement: string;
  sortOrder: number;
}

interface TradingMeasurement {
  nodeId: string;
  targetId: string;
  networkProfile: string;
  status: "succeeded" | "failed";
  measuredAt: string;
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
  totalP50Ms?: number;
  totalP95Ms?: number;
  jitterMs?: number;
  sampleCount: number;
  failureCount: number;
  errorCode?: string;
}

interface TradingPayload {
  generatedAt: string;
  nodes: TradingNode[];
  targets: TradingTarget[];
  measurements: TradingMeasurement[];
}

interface LeafletMapInstance {
  getCenter(): { lat: number; lng: number };
  getZoom(): number;
  invalidateSize(): void;
  remove(): void;
  setView(center: [number, number], zoom: number): LeafletMapInstance;
}

interface LeafletLayer {
  addTo(map: LeafletMapInstance): LeafletLayer;
  bindTooltip(content: string, options?: Record<string, unknown>): LeafletLayer;
}

interface LeafletApi {
  map(element: HTMLElement, options: Record<string, unknown>): LeafletMapInstance;
  tileLayer(url: string, options: Record<string, unknown>): LeafletLayer;
  circleMarker(position: [number, number], options: Record<string, unknown>): LeafletLayer;
}

declare global {
  interface Window {
    L?: LeafletApi;
  }
}

const sections = [
  ["cex", "CEX"],
  ["hyperliquid", "Hyperliquid"],
  ["prediction-markets", "Prediction Markets"],
  ["sui", "SUI"],
  ["arbitrum", "Arbitrum One"],
  ["robinhood", "Robinhood Chain"],
  ["base", "Base"],
  ["xlayer", "X Layer"],
  ["ink", "Ink"],
  ["op", "OP Mainnet"],
  ["zksync", "ZKsync Era"],
  ["oracle", "Oracle"],
  ["routes", "Arb Routes"]
] as const;

const sectionAliases: Record<string, string> = {
  robinhood: "robinhood",
  base: "base",
  xlayer: "xlayer",
  ink: "ink",
  op: "op",
  zksync: "zksync",
  oracle: "oracle",
  routes: "routes"
};

let refreshTimer: number | null = null;
let activeTradingMap: LeafletMapInstance | null = null;
let savedMapView: { latitude: number; longitude: number; zoom: number } | null = null;

export function isTradingPath(pathname: string = window.location.pathname): boolean {
  return pathname === "/trading" || pathname.startsWith("/trading/");
}

export async function startTradingApp(root: HTMLElement): Promise<void> {
  document.title = "Hyperspace Trading Latency";
  root.innerHTML = tradingLoading();
  await renderTrading(root);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopRefresh();
    } else {
      void renderTrading(root);
    }
  });
}

async function renderTrading(root: HTMLElement): Promise<void> {
  stopRefresh();
  try {
    const response = await fetch("/api/v1/public/trading/latency", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as TradingPayload;
    destroyTradingMap();
    root.innerHTML = tradingView(payload);
    bindTradingHandlers(root, payload);
  } catch (error) {
    destroyTradingMap();
    root.innerHTML = tradingUnavailable(error instanceof Error ? error.message : "unavailable");
  }
  if (!document.hidden) {
    refreshTimer = window.setTimeout(() => void renderTrading(root), 15_000);
  }
}

function stopRefresh(): void {
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function currentRoute(): { section: string; view: "map" | "status" | "about" } {
  const parts = window.location.pathname.split("/").filter(Boolean);
  const requested = parts[1] ?? "cex";
  const section = sections.some(([key]) => key === requested) ? requested : "cex";
  const view = parts[2] === "status" ? "status" : parts[2] === "about" ? "about" : "map";
  return { section, view };
}

function tradingView(payload: TradingPayload): string {
  const route = currentRoute();
  const label = sections.find(([key]) => key === route.section)?.[1] ?? "Trading";
  const targets = payload.targets.filter((target) => target.category === route.section || sectionAliases[route.section] === target.category);
  const selectedKey = new URLSearchParams(window.location.search).get("target");
  const target = targets.find((candidate) => candidate.key === selectedKey) ?? targets[0];
  return `
    <main class="trading-shell">
      <nav class="trading-product-nav" aria-label="Trading latency sections">
        <a class="trading-brand" href="/trading/cex"><img class="trading-brand-logo" src="/hyperspace-logo.svg" alt="" /><strong>Hyperspace Latency</strong></a>
        <div class="trading-section-links">
          ${sections.map(([key, text]) => `<a href="/trading/${key}" class="${key === route.section ? "active" : ""}">${escapeHtml(text)}</a>`).join("")}
        </div>
        <a class="trading-vpn-link" href="/">VPN App →</a>
      </nav>
      <header class="trading-context-nav">
        <div>
          <span class="trading-live-dot"></span>
          <strong>${escapeHtml(label)}</strong>
        </div>
        <nav aria-label="Current section">
          <a href="/trading/${route.section}" class="${route.view === "map" ? "active" : ""}">Map</a>
          <a href="/trading/${route.section}/status" class="${route.view === "status" ? "active" : ""}">Status</a>
          <a href="/trading/${route.section}/about" class="${route.view === "about" ? "active" : ""}">About</a>
        </nav>
        <small>Direct public-path measurements · updated ${escapeHtml(relativeTime(payload.generatedAt))}</small>
      </header>
      ${route.view === "map" ? mapView(payload, targets, target) : route.view === "status" ? statusView(payload, targets) : aboutView(label, targets)}
    </main>
  `;
}

function mapView(payload: TradingPayload, targets: TradingTarget[], target: TradingTarget | undefined): string {
  if (!target) {
    return plannedSection(payload, currentRoute().section);
  }
  const measurements = new Map(
    payload.measurements
      .filter((entry) => entry.targetId === target.id && entry.networkProfile === "direct")
      .map((entry) => [entry.nodeId, entry])
  );
  const ranked = payload.nodes
    .map((node) => ({ node, measurement: measurements.get(node.id) }))
    .sort((left, right) => metricValue(left.measurement) - metricValue(right.measurement));
  const successful = ranked.filter((row) => row.measurement?.status === "succeeded" && Number.isFinite(row.measurement.totalP50Ms));
  const best = successful[0];
  return `
    <section class="trading-dashboard">
      <div class="trading-map-panel">
        <div class="trading-map-controls">
          <label>
            <span>Endpoint</span>
            <select id="trading-target-select">
              ${targets.map((candidate) => `<option value="${escapeHtml(candidate.key)}" ${candidate.id === target.id ? "selected" : ""}>${escapeHtml(candidate.displayName)} · ${escapeHtml(candidate.product)}</option>`).join("")}
            </select>
          </label>
          <div class="trading-measurement-pill">${escapeHtml(target.measurement)}</div>
        </div>
        <div class="trading-map-summary">
          <div><small>Best location</small><strong>${best ? escapeHtml(best.node.city) : "Waiting for data"}</strong></div>
          <div><small>Lowest p50</small><strong>${best?.measurement?.totalP50Ms !== undefined ? formatMs(best.measurement.totalP50Ms) : "—"}</strong></div>
          <div><small>Reporting</small><strong>${successful.length}/${payload.nodes.length}</strong></div>
        </div>
        ${worldMap()}
        <div class="trading-map-legend" aria-label="Latency color scale">
          <span><i style="--dot:#33d17a"></i>&lt; 50 ms</span>
          <span><i style="--dot:#b6e53c"></i>50–100 ms</span>
          <span><i style="--dot:#ffc857"></i>100–200 ms</span>
          <span><i style="--dot:#ff6b57"></i>&gt; 200 ms</span>
          <span><i style="--dot:#7b8190"></i>No data</span>
        </div>
      </div>
      <aside class="trading-ranking-panel">
        <div class="trading-ranking-heading">
          <div><small>Global probes</small><h1>${escapeHtml(target.displayName)} ${escapeHtml(target.product)}</h1></div>
          <span class="trading-protocol">${escapeHtml(protocolLabel(target.protocol))}</span>
        </div>
        <div class="trading-rank-list">
          ${ranked.map((row, index) => rankRow(row.node, row.measurement, index + 1)).join("")}
        </div>
      </aside>
    </section>
  `;
}

function worldMap(): string {
  return `<div class="trading-map-wrap"><div id="trading-map" role="img" aria-label="Interactive world map of trading latency probe locations"></div></div>`;
}

function rankRow(node: TradingNode, measurement: TradingMeasurement | undefined, rank: number): string {
  const success = measurement?.status === "succeeded" && measurement.totalP50Ms !== undefined;
  const status = success ? "Live" : measurement?.errorCode ?? (node.fresh ? "Waiting" : "Probe offline");
  return `<article class="trading-rank-row">
    <span class="trading-rank-number">${rank}</span>
    <i class="trading-rank-dot" style="--dot:${latencyColor(measurement)}"></i>
    <div class="trading-rank-location"><strong>${escapeHtml(node.city)}</strong><small>${escapeHtml(node.country)} · ${escapeHtml(node.provider || node.regionCode)}</small></div>
    <div class="trading-rank-metric"><strong>${success ? formatMs(measurement.totalP50Ms!) : "—"}</strong><small>${escapeHtml(status)}</small></div>
    <div class="trading-rank-secondary"><span>p95 ${success && measurement.totalP95Ms !== undefined ? formatMs(measurement.totalP95Ms) : "—"}</span><span>TTFB ${success && measurement.ttfbMs !== undefined ? formatMs(measurement.ttfbMs) : "—"}</span></div>
  </article>`;
}

function statusView(payload: TradingPayload, targets: TradingTarget[]): string {
  return `<section class="trading-document-view">
    <header><small>System status</small><h1>Probe and endpoint coverage</h1><p>Node heartbeat and latest measurements are independent from the VPN gate-agent.</p></header>
    <div class="trading-status-grid">
      ${payload.nodes.map((node) => `<article><i class="${node.fresh ? "fresh" : "stale"}"></i><div><strong>${escapeHtml(node.city)}</strong><small>${escapeHtml(node.name)}</small></div><span>${node.fresh ? "Online" : "Stale"}</span></article>`).join("") || "<p>No probe nodes registered.</p>"}
    </div>
    <h2>Endpoints in this section</h2>
    <div class="trading-target-grid">${targets.map((target) => `<article><strong>${escapeHtml(target.displayName)}</strong><span>${escapeHtml(target.product)}</span><small>${escapeHtml(target.measurement)}</small></article>`).join("") || "<p>Targets are planned but not enabled yet.</p>"}</div>
  </section>`;
}

function aboutView(label: string, targets: TradingTarget[]): string {
  const oracleNote = label === "Oracle"
    ? `<article><h2>Oracle limitation</h2><p>Pyth routers are measured through a public TLS handshake. Switchboard and Chainlink use public health endpoints. These are network-path estimates, not authenticated feed delivery, update freshness, or publish-to-receive latency.</p></article>`
    : "";
  return `<section class="trading-document-view">
    <header><small>Methodology</small><h1>${escapeHtml(label)} latency</h1><p>Measurements originate from independently managed Hyperspace probe agents and use the direct public network path in this release.</p></header>
    <div class="trading-copy-columns">
      <article><h2>What the number means</h2><p>The headline value is median application round-trip time. REST and JSON-RPC include request handling and response time; they must not be compared as if they were a pure network ping.</p></article>
      <article><h2>What it does not mean</h2><p>These values are not fill latency, execution guarantees, matching-engine latency, or proof of a DoubleZero/WireGuard path. CDN-fronted connection timings may terminate at an edge.</p></article>
      <article><h2>Safety</h2><p>The canary uses public read-only endpoints. It does not submit orders or valid funded transactions and does not require exchange API keys or treasury wallets.</p></article>
      ${oracleNote}
    </div>
    <div class="trading-target-grid">${targets.map((target) => `<article><strong>${escapeHtml(target.displayName)}</strong><span>${escapeHtml(target.product)}</span><small>${escapeHtml(target.measurement)}</small></article>`).join("") || "<p>This category will be added after the initial canary.</p>"}</div>
  </section>`;
}

function plannedSection(payload: TradingPayload, section: string): string {
  const title = sections.find(([key]) => key === section)?.[1] ?? section;
  return `<section class="trading-empty-state"><span>Derived view planned</span><h1>${escapeHtml(title)}</h1><p>Arbitrage routes will combine compatible venue measurements from the same probe node and time window. The underlying CEX and market samples are already collected; the derived score will be added without generating extra probe traffic.</p><strong>${payload.nodes.length} probe locations registered</strong></section>`;
}

function bindTradingHandlers(root: HTMLElement, payload: TradingPayload): void {
  initializeTradingMap(root, payload);
  const select = root.querySelector<HTMLSelectElement>("#trading-target-select");
  select?.addEventListener("change", () => {
    const url = new URL(window.location.href);
    url.searchParams.set("target", select.value);
    window.history.replaceState({}, "", url);
    destroyTradingMap();
    root.innerHTML = tradingView(payload);
    bindTradingHandlers(root, payload);
  });
}

function initializeTradingMap(root: HTMLElement, payload: TradingPayload): void {
  const route = currentRoute();
  if (route.view !== "map") return;
  const mapElement = root.querySelector<HTMLElement>("#trading-map");
  const leaflet = window.L;
  if (!mapElement || !leaflet) {
    if (mapElement) mapElement.textContent = "Interactive map library is unavailable.";
    return;
  }
  const targets = payload.targets.filter((target) => target.category === route.section || sectionAliases[route.section] === target.category);
  const selectedKey = new URLSearchParams(window.location.search).get("target");
  const target = targets.find((candidate) => candidate.key === selectedKey) ?? targets[0];
  if (!target) return;
  const measurements = new Map(
    payload.measurements
      .filter((entry) => entry.targetId === target.id && entry.networkProfile === "direct")
      .map((entry) => [entry.nodeId, entry])
  );
  const initial = savedMapView ?? { latitude: 0, longitude: 8, zoom: 2 };
  activeTradingMap = leaflet.map(mapElement, {
    attributionControl: true,
    maxBounds: [[-85, -180], [85, 180]],
    maxBoundsViscosity: 1,
    minZoom: 2,
    maxZoom: 12,
    worldCopyJump: false
  }).setView([initial.latitude, initial.longitude], initial.zoom);
  leaflet.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    bounds: [[-85, -180], [85, 180]],
    keepBuffer: 0,
    maxZoom: 19,
    noWrap: true
  }).addTo(activeTradingMap);
  for (const node of payload.nodes) {
    const measurement = measurements.get(node.id);
    const success = measurement?.status === "succeeded" && measurement.totalP50Ms !== undefined;
    const value = success ? formatMs(measurement.totalP50Ms!) : measurement?.errorCode ?? (node.fresh ? "Waiting for data" : "Probe offline");
    const marker = leaflet.circleMarker([node.latitude, node.longitude], {
      bubblingMouseEvents: false,
      color: "#ffffff",
      fillColor: latencyColor(measurement),
      fillOpacity: 1,
      opacity: 0.95,
      radius: 7,
      weight: 1.5
    });
    marker.addTo(activeTradingMap).bindTooltip(
      `<strong>${escapeHtml(node.city)}, ${escapeHtml(node.country)}</strong><br>${escapeHtml(node.name)}<br><b>${escapeHtml(value)}</b>`,
      { className: "trading-map-tooltip", direction: "top", offset: [0, -8] }
    );
  }
  window.setTimeout(() => activeTradingMap?.invalidateSize(), 0);
}

function destroyTradingMap(): void {
  if (!activeTradingMap) return;
  const center = activeTradingMap.getCenter();
  savedMapView = { latitude: center.lat, longitude: center.lng, zoom: activeTradingMap.getZoom() };
  activeTradingMap.remove();
  activeTradingMap = null;
}

function tradingLoading(): string {
  return `<main class="trading-shell trading-centered"><div class="trading-loader"></div><strong>Loading global latency data</strong></main>`;
}

function tradingUnavailable(message: string): string {
  return `<main class="trading-shell trading-centered"><span class="trading-error-mark">!</span><h1>Trading latency is temporarily unavailable</h1><p>${escapeHtml(message)}</p><button onclick="location.reload()">Retry</button><a href="/">Return to VPN app</a></main>`;
}

function latencyColor(measurement: TradingMeasurement | undefined): string {
  const band = tradingLatencyBand(
    measurement?.status === "succeeded" ? measurement.totalP50Ms : undefined
  );
  return {
    fast: "#33d17a",
    good: "#b6e53c",
    slow: "#ffc857",
    critical: "#ff6b57",
    unavailable: "#7b8190"
  }[band];
}

export function tradingLatencyBand(
  p50Ms: number | undefined
): "fast" | "good" | "slow" | "critical" | "unavailable" {
  if (p50Ms === undefined || !Number.isFinite(p50Ms) || p50Ms < 0) return "unavailable";
  if (p50Ms < 50) return "fast";
  if (p50Ms < 100) return "good";
  if (p50Ms < 200) return "slow";
  return "critical";
}

function metricValue(measurement: TradingMeasurement | undefined): number {
  return measurement?.status === "succeeded" && measurement.totalP50Ms !== undefined ? measurement.totalP50Ms : Number.POSITIVE_INFINITY;
}

function formatMs(value: number): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
}

function protocolLabel(protocol: string): string {
  return protocol === "json_rpc" ? "JSON-RPC" : protocol === "http_json" ? "REST" : protocol === "tcp_tls" ? "TCP + TLS" : protocol.toUpperCase();
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  return seconds < 5 ? "just now" : seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}
