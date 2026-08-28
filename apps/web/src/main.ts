import { benchmarkRequestTimeoutMs, shouldLoadBenchmarkMatrix } from "./benchmark-isolation.js";
import { isTradingPath, startTradingApp } from "./trading.js";

type SessionMode = "IpToIp" | "FullTunnel";
type AppView = "dashboard" | "create-config" | "benchmarks" | "billing" | "admin-billing" | "login" | "register";
type CreateConfigStep = "configure" | "confirm" | "result";
type SortDirection = "desc" | "asc";
type KeyInstructionPlatform = "linux" | "macos" | "windows";
type GateSortField = "browser-rtt" | "clock-error";
type BenchmarkRttSortField = "route" | "doublezeroRtt" | "internetRtt" | "improvement" | "rttSaved" | "ingressDzRtt" | "egressDzRtt" | "doublezeroJitter" | "internetJitter" | "jitterImprovement" | "jitterSaved" | "loss";
type BenchmarkOneWaySortField = "route" | "doublezeroOneWay" | "internetOneWay" | "oneWayImprovement" | "oneWaySaved" | "oneWayClockError" | "doublezeroOneWayJitter" | "internetOneWayJitter" | "oneWayJitterImprovement" | "oneWayJitterSaved" | "ingressDzOneWay" | "egressDzOneWay";
type SessionValidationErrors = Partial<Record<"sourceIp" | "targetIp" | "ingressGateName" | "egressGateName" | "clientPublicKey", string>>;

interface Gate {
  id: string;
  name: string;
  city?: string;
  country?: string;
  publicIpv4: string;
  probeUrl?: string;
  clockErrorMs?: number;
  doubleZero?: GateDoubleZeroStatus;
  ready: boolean;
  schedulable: boolean;
  browserLatencyMs?: number | null;
  browserLatencyStatus?: "measured" | "unavailable" | "measuring";
}

interface GateDoubleZeroStatus {
  currentDevice?: string;
  lowestLatencyDevice?: string;
  lowestLatencyDeviceWarning?: boolean;
  metro?: string;
  network?: string;
  edgeRttMs?: number;
  edgeRttTarget?: string;
  edgeRttInterface?: string;
  edgeRttMeasuredAt?: string;
  edgeRttError?: string;
  reportedAt?: string;
  error?: string;
}

interface BenchmarkMetricSummary {
  min?: number;
  p50?: number;
  p95?: number;
  max?: number;
}

interface BenchmarkMetric {
  transport: "public" | "doublezero";
  status: "succeeded" | "failed";
  sourceInterface?: string;
  targetEndpoint?: string;
  packetCount?: number;
  packetsReceived?: number;
  lossPercent?: number;
  rttMs?: BenchmarkMetricSummary;
  jitterMs?: number;
  forwardOneWayMs?: BenchmarkMetricSummary;
  oneWayDiagnostics?: {
    clockErrorMs?: number;
  };
  errorCode?: string;
  errorMessage?: string;
  measuredAt: string;
}

interface BenchmarkDoublezeroApplicability {
  status: "not_applicable";
  reason: "same_doublezero_metro";
  metro: string;
}

interface BenchmarkRoute {
  sourceGateId: string;
  sourceGateName: string;
  targetGateId: string;
  targetGateName: string;
  public?: BenchmarkMetric;
  doublezero?: BenchmarkMetric;
  doublezeroApplicability?: BenchmarkDoublezeroApplicability;
  delta?: {
    rttP50Ms?: number;
    jitterMs?: number;
    lossPercent?: number;
    forwardOneWayP50Ms?: number;
  };
}

interface BenchmarkMatrix {
  generatedAt: string;
  gates: Gate[];
  routes: BenchmarkRoute[];
}

interface BenchmarkRouteRow {
  route: BenchmarkRoute;
  sourceGate: Gate;
  targetGate: Gate;
  routeLabel: string;
  cityLabel: string;
  sourceCity: string;
  targetCity: string;
  publicRttMs: number | undefined;
  doublezeroRttMs: number | undefined;
  ingressDzRttMs: number | undefined;
  egressDzRttMs: number | undefined;
  ingressDzOneWayMs: number | undefined;
  egressDzOneWayMs: number | undefined;
  publicJitterMs: number | undefined;
  doublezeroJitterMs: number | undefined;
  jitterSavedMs: number | undefined;
  jitterImprovementPercent: number | undefined;
  publicLossPercent: number | undefined;
  doublezeroLossPercent: number | undefined;
  publicOneWayMs: number | undefined;
  doublezeroOneWayMs: number | undefined;
  publicOneWayClockErrorMs: number | undefined;
  doublezeroOneWayClockErrorMs: number | undefined;
  oneWayClockErrorMs: number | undefined;
  publicOneWayJitterMs: number | undefined;
  doublezeroOneWayJitterMs: number | undefined;
  oneWayJitterSavedMs: number | undefined;
  oneWayJitterImprovementPercent: number | undefined;
  oneWaySavedMs: number | undefined;
  oneWayImprovementPercent: number | undefined;
  rttSavedMs: number | undefined;
  rttImprovementPercent: number | undefined;
}

interface Session {
  id: string;
  mode: SessionMode;
  phase: string;
  desiredState: string;
  label?: string;
  destinationCidrs: string[];
  sourceCidr?: string;
  selectedPath?: {
    ingressGateName?: string;
    egressGateName?: string;
  };
  lastError?: {
    code?: string;
    message?: string;
  };
  createdAt: string;
}

interface Me {
  id?: string;
  accountId?: string;
  email: string;
  displayName?: string;
  avatarUrl?: string | null;
  billingAdmin: boolean;
}

interface BillingLedgerEntry {
  id: string;
  entryType: string;
  amountMinor: number;
  currency: string;
  sourceType: string;
  sourceId: string;
  description: string;
  createdAt: string;
}

interface BillingSummary {
  accountId: string;
  balanceMinor: number;
  currency: string;
  ledger: BillingLedgerEntry[];
  deposit: BillingDepositDestination | null;
  deposits: BillingDeposit[];
  availableBalanceMinor: number;
  withdrawableBalanceMinor: number;
  buckets: { cashMinor: number; promotionalMinor: number; reservedWithdrawalMinor: number; debtMinor: number };
  state: { state: string; suspensionDueAt?: string | null; withdrawalEligibleAt?: string | null; lastSettledAt?: string | null };
  plan: { code: string; version: number; displayName: string; activeConfigMonthlyMinor: number; trafficPerGbMinor: number; gracePeriodSeconds: number; withdrawalCooldownSeconds: number; minimumWithdrawalMinor: number };
  usage: BillingUsageSummary[];
  withdrawals: WithdrawalRequest[];
  walletBalanceBaseUnits: string | null;
  walletSpendableBaseUnits: string | null;
  walletRentReserveBaseUnits: string | null;
  configPriceBaseUnits: string;
}

interface BillingDepositDestination {
  chain: "solana";
  address: string;
  tokenSymbol: string;
  tokenMint: string;
  tokenDecimals: number;
  qrSvg: string;
}

interface BillingDeposit {
  transactionSignature: string;
  chain: "solana";
  status: "finalized";
  tokenSymbol: string;
  tokenMint: string;
  tokenAmountBaseUnits: string;
  tokenDecimals: number;
  creditedAmountMinor: number;
  currency: string;
  observedAt: string;
  explorerUrl: string;
}

interface BillingUsageSummary {
  sessionId: string;
  sessionLabel?: string | null;
  activeSeconds: number;
  bytesToDestination: string;
  bytesFromDestination: string;
  chargeMinor: number;
  estimatedChargeMicrominor: string;
  lastRatedAt: string;
}

interface WithdrawalRequest {
  id: string;
  status: string;
  amountMinor: number;
  currency: string;
  tokenSymbol: string;
  destinationAddress: string;
  eligibleAt: string;
  transactionSignature?: string | null;
  requestedAt: string;
}

interface AdminBillingCustomer {
  accountId: string;
  email: string;
  displayName: string;
  state: string;
  balanceMinor: number;
  cashMinor: number;
  promotionalMinor: number;
  reservedWithdrawalMinor: number;
  debtMinor: number;
  activeConfigCount: number;
  planCode: string;
  planVersion: number;
  suspensionDueAt?: string | null;
  lastSettledAt?: string | null;
}

interface AdminBillingSummary {
  customers: AdminBillingCustomer[];
  configs: AdminBillingConfig[];
  payments: AdminConfigPayment[];
  deposits: AdminDeposit[];
  treasury: AdminTreasurySummary;
  asset: AdminBillingAsset;
}

interface AdminTreasurySummary {
  address: string | null;
  balanceBaseUnits: string | null;
  status: "available" | "unavailable" | "not_configured";
  checkedAt: string;
}

interface AdminBillingConfig {
  sessionId: string;
  accountId: string;
  customerEmail: string;
  label?: string | null;
  mode: string;
  phase: string;
  desiredState: string;
  ingressGateName?: string | null;
  egressGateName?: string | null;
  activeSeconds: number;
  bytesToDestination: string;
  bytesFromDestination: string;
  droppedBytes: string;
  payloadBytes: string;
  chargeMinor: number;
  firstTrafficAt?: string | null;
  lastTrafficAt?: string | null;
  paymentStatus?: string | null;
  paymentAmountLamports?: string | null;
  paymentFeeLamports?: string | null;
  paymentTransactionSignature?: string | null;
  paymentConfirmedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  hiddenAt?: string | null;
  lastRatedAt?: string | null;
}

interface AdminConfigPayment {
  paymentId: string;
  sessionId?: string | null;
  accountId: string;
  customerEmail: string;
  sessionLabel?: string | null;
  status: string;
  amountLamports: string;
  feeLamports?: string | null;
  transactionSignature?: string | null;
  failureCode?: string | null;
  failureReason?: string | null;
  createdAt: string;
  submittedAt?: string | null;
  confirmedAt?: string | null;
}

interface AdminDeposit {
  transactionSignature: string;
  accountId: string;
  customerEmail: string;
  walletAddress?: string | null;
  tokenMint?: string | null;
  amountBaseUnits?: string | null;
  creditedAmountMinor: string;
  observedAt: string;
}

interface AdminBillingAsset {
  symbol: string;
  decimals: number;
  explorerTransactionBaseUrl: string;
  configPriceBaseUnits: string;
}

interface AdminTrafficPoint {
  bucketStart: string;
  bytesToDestination: string;
  bytesFromDestination: string;
  droppedBytes: string;
  configCount: number;
}

interface AdminTrafficSeries {
  range: "24h" | "7d" | "30d";
  sessionId?: string | null;
  from: string;
  to: string;
  bucketSeconds: number;
  points: AdminTrafficPoint[];
}

const apiBase = (window as unknown as { HYPERSPACE_API_BASE?: string }).HYPERSPACE_API_BASE ?? "/api";
const wireGuardCanonicalBase64Pattern = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const benchmarkFreshWindowMs = 15 * 60 * 1000;
let token = consumeOauthTokenFromLocation() || localStorage.getItem("hyperspaceAccessToken") || "";
let latestGates: Gate[] = [];
let latestSessions: Session[] = [];
let latestMe: Me | null = null;
let latestBenchmarkMatrix: BenchmarkMatrix | null = null;
let latestBilling: BillingSummary | null = null;
let latestAdminBilling: AdminBillingSummary | null = null;
let latestAdminTraffic: AdminTrafficSeries | null = null;
let adminTrafficRange: AdminTrafficSeries["range"] = "24h";
let adminTrafficSessionId = "";
let adminConfigFilter = "active";
let adminConfigSearch = "";
let adminTrafficLoading = false;
const gateLatencyById = new Map<string, { medianMs: number | null; minMs: number | null; maxMs: number | null; sampleCount: number }>();
const gateLatencyInProgressIds = new Set<string>();
const revokingConfigIds = new Set<string>();
const deletingConfigIds = new Set<string>();
let sessionAutoRefreshTimer: number | null = null;
let sessionRefreshInFlight = false;
let automaticGateLatencyMeasurementStarted = false;
let gateLatencyMeasurementInFlight = false;
let browserIp = "";
let currentView: AppView = viewFromLocation();
let createConfigStep: CreateConfigStep = "configure";
let createConfigSubmitting = false;
let createConfigOptionsOpen = false;
let excludedCountriesOpen = false;
let excludedCitiesOpen = false;
let createConfigPaymentRequestId = "";
let createConfigPaymentError = "";
let createdConfigSessionId = "";
let createdConfigSessionPhase = "";
let createdConfigError = "";
let createdConfigQrSvg = "";
let gateSortField: GateSortField = "browser-rtt";
let gateBrowserRttSortDirection: SortDirection = "asc";
let gateClockErrorSortDirection: SortDirection = "asc";
let benchmarkRttSortField: BenchmarkRttSortField = "improvement";
let benchmarkRttSortDirection: SortDirection = "desc";
let benchmarkOneWaySortField: BenchmarkOneWaySortField = "oneWayImprovement";
let benchmarkOneWaySortDirection: SortDirection = "desc";
let benchmarkCityFilter = "";
let sessionValidationErrors: SessionValidationErrors = {};
let emailOtpPendingEmail = "";
let emailOtpBusy = false;
let googleLoginBusy = false;
let withdrawalBusy = false;
let gateCatalogLoadError = false;
let activeConfigQrSvg = "";
let activeConfigQrSessionId = "";
let ingressGateManuallySelected = false;
let keyInstructionPlatform: KeyInstructionPlatform = "linux";
const eventLogLines: string[] = [];

const sessionDraft = {
  mode: "FullTunnel" as SessionMode,
  label: "",
  restrictSource: false,
  sourceIp: "",
  restrictTarget: false,
  targetIp: "",
  ingressGateName: "",
  egressGateName: "",
  useClientPublicKey: false,
  clientPublicKey: "",
  excludeCountries: [] as string[],
  excludeCities: [] as string[],
  preferredRegion: ""
};

const root = document.getElementById("app");
if (!root) {
  throw new Error("missing #app");
}
const appRoot = root;

if (isTradingPath()) {
  void startTradingApp(appRoot);
} else {
  renderLoading();
  window.addEventListener("popstate", () => {
    currentView = viewFromLocation();
    if (currentView !== "create-config") {
      createConfigStep = "configure";
    }
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    if (shouldLoadBenchmarkMatrix(currentView)) {
      void refreshBenchmarkView();
    }
  });
  void refresh();
}

function renderLoading(): void {
  appRoot.innerHTML = `
    <main class="shell">
      <section class="topbar">
        <div>
          <h1>DoubleZero WireGuard VPN</h1>
          <p>DoubleZero-backed WireGuard configs across Hyperspace gates.</p>
        </div>
        <div class="identity">
          <span>Loading</span>
        </div>
      </section>
    </main>
  `;
}

async function refresh(options: { skipAutoMeasure?: boolean } = {}): Promise<void> {
  const loadBenchmarks = shouldLoadBenchmarkMatrix(currentView);
  const [gateResult, sessions, me, benchmarkMatrix, billing] = await Promise.all([
    getGates()
      .then((gates) => ({ gates, error: null }))
      .catch((error: unknown) => ({ gates: null, error })),
    token ? getSessions().catch(() => [] as Session[]) : Promise.resolve([]),
    token ? getMe().catch(() => null) : Promise.resolve(null),
    loadBenchmarks ? getBenchmarkMatrix().catch(() => null) : Promise.resolve(latestBenchmarkMatrix),
    token ? getBilling().catch(() => null) : Promise.resolve(null)
  ]);
  const [adminBilling, adminTraffic] = token && me?.billingAdmin
    ? await Promise.all([
      getAdminBilling().catch(() => null),
      getAdminTraffic().catch(() => null)
    ])
    : [null, null];
  const gates = gateResult.gates ?? benchmarkMatrix?.gates ?? latestGates;
  gateCatalogLoadError = gateResult.error !== null && gates.length === 0;
  if (gateCatalogLoadError) {
    log("Could not load the gate catalog. Retry after checking the control-plane connection.");
  }
  latestGates = gates;
  latestSessions = sessions;
  latestMe = me;
  latestBenchmarkMatrix = benchmarkMatrix;
  latestBilling = billing;
  latestAdminBilling = adminBilling;
  latestAdminTraffic = adminTraffic;
  render({ gates: decorateGates(gates), sessions, me, benchmarkMatrix, billing });
  if (!options.skipAutoMeasure && me) {
    maybeMeasureGatesAutomatically();
  }
}

function render(state: { gates?: Gate[]; sessions?: Session[]; me?: Me | null; benchmarkMatrix?: BenchmarkMatrix | null; billing?: BillingSummary | null } = {}): void {
  const gates = state.gates ?? [];
  const sessions = state.sessions ?? [];
  const me = state.me ?? null;
  const benchmarkMatrix = state.benchmarkMatrix ?? latestBenchmarkMatrix;
  const billing = state.billing === undefined ? latestBilling : state.billing;
  const view = resolveViewForAuth(me);
  appRoot.innerHTML = `
    <main class="shell">
      <section class="topbar">
        <div>
          <h1>DoubleZero WireGuard VPN</h1>
          <p>DoubleZero-backed WireGuard configs across Hyperspace gates.</p>
        </div>
        <div class="identity">
          ${me ? `${headerBalance(billing)}${me.avatarUrl ? `<img class="identity-avatar" src="${escapeHtml(me.avatarUrl)}" alt="" referrerpolicy="no-referrer" />` : ""}<span>${escapeHtml(me.displayName || me.email)}</span><button id="logout">Log out</button>` : '<a class="button-link secondary-button" href="/login" data-view="login">Log in</a>'}
        </div>
      </section>

      ${me ? appNav(view) : authNav(view)}
      ${renderView({ view, gates, sessions, benchmarkMatrix, billing })}

      ${shouldShowEventLog(view, me) ? `<pre id="event-log" class="event-log">${escapeHtml(eventLogLines.join("\n"))}</pre>` : ""}
    </main>
  `;
  bindHandlers();
  syncSessionAutoRefresh(view, me, sessions);
}

function syncSessionAutoRefresh(view: AppView, me: Me | null, sessions: Session[]): void {
  const shouldRefresh = Boolean(me && view === "dashboard" && sessions.some(sessionNeedsAutoRefresh));
  if (!shouldRefresh) {
    stopSessionAutoRefresh();
    return;
  }
  if (sessionAutoRefreshTimer !== null) {
    return;
  }
  sessionAutoRefreshTimer = window.setInterval(() => {
    void refreshDashboardSessions();
  }, 1000);
}

function stopSessionAutoRefresh(): void {
  if (sessionAutoRefreshTimer === null) {
    return;
  }
  window.clearInterval(sessionAutoRefreshTimer);
  sessionAutoRefreshTimer = null;
}

function navigateToView(view: AppView): void {
  currentView = view;
  if (view !== "create-config") {
    resetCreatedConfigResult();
    createConfigStep = "configure";
  }
  window.history.pushState({}, "", viewPath(view));
  render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  if (shouldLoadBenchmarkMatrix(view)) {
    void refreshBenchmarkView();
  }
}

async function refreshBenchmarkView(): Promise<void> {
  try {
    const benchmarkMatrix = await getBenchmarkMatrix();
    latestBenchmarkMatrix = benchmarkMatrix;
    if (latestGates.length === 0 && benchmarkMatrix.gates) {
      latestGates = benchmarkMatrix.gates;
    }
    if (currentView === "benchmarks") {
      render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe, benchmarkMatrix });
    }
  } catch {
    if (currentView === "benchmarks") {
      log("Benchmark data is temporarily unavailable; VPN configuration remains available.");
    }
  }
}

function viewFromLocation(): AppView {
  if (window.location.pathname === "/create-config") {
    return "create-config";
  }
  if (window.location.pathname === "/benchmarks") {
    return "benchmarks";
  }
  if (window.location.pathname === "/billing") {
    return "billing";
  }
  if (window.location.pathname === "/admin/billing") {
    return "admin-billing";
  }
  if (window.location.pathname === "/register") {
    return "register";
  }
  if (window.location.pathname === "/login") {
    return "login";
  }
  return "dashboard";
}

function viewPath(view: AppView): string {
  if (view === "create-config") {
    return "/create-config";
  }
  if (view === "benchmarks") {
    return "/benchmarks";
  }
  if (view === "billing") {
    return "/billing";
  }
  if (view === "admin-billing") {
    return "/admin/billing";
  }
  if (view === "login") {
    return "/login";
  }
  if (view === "register") {
    return "/register";
  }
  return "/";
}

function resolveViewForAuth(me: Me | null): AppView {
  let view = currentView;
  if (!me && view !== "login" && view !== "register" && view !== "benchmarks") {
    view = "login";
  }
  if (me && (view === "login" || view === "register")) {
    view = "dashboard";
  }
  if (view !== currentView) {
    currentView = view;
    window.history.replaceState({}, "", viewPath(view));
  }
  return view;
}

function renderView(state: { view: AppView; gates: Gate[]; sessions: Session[]; benchmarkMatrix: BenchmarkMatrix | null; billing: BillingSummary | null }): string {
  if (state.view === "login") {
    return loginView();
  }
  if (state.view === "register") {
    return registerView();
  }
  if (state.view === "create-config") {
    return createConfigView(state.gates);
  }
  if (state.view === "benchmarks") {
    return benchmarksView({ gates: state.gates, benchmarkMatrix: state.benchmarkMatrix });
  }
  if (state.view === "billing") {
    return billingView(state.billing);
  }
  if (state.view === "admin-billing") {
    return adminBillingView(latestAdminBilling);
  }
  return dashboardView({ gates: state.gates, sessions: state.sessions, benchmarkMatrix: state.benchmarkMatrix });
}

function shouldShowEventLog(view: AppView, me: Me | null): boolean {
  return Boolean(me) && view !== "login" && view !== "register";
}

function isAppView(value: string | undefined): value is AppView {
  return value === "dashboard" || value === "create-config" || value === "benchmarks" || value === "billing" || value === "admin-billing" || value === "login" || value === "register";
}

function isKeyInstructionPlatform(value: string | undefined): value is KeyInstructionPlatform {
  return value === "linux" || value === "macos" || value === "windows";
}

function isGateSortField(value: string | undefined): value is GateSortField {
  return value === "browser-rtt" || value === "clock-error";
}

function isBenchmarkRttSortField(value: string | undefined): value is BenchmarkRttSortField {
  return value === "route" ||
    value === "doublezeroRtt" ||
    value === "internetRtt" ||
    value === "improvement" ||
    value === "rttSaved" ||
    value === "ingressDzRtt" ||
    value === "egressDzRtt" ||
    value === "doublezeroJitter" ||
    value === "internetJitter" ||
    value === "jitterImprovement" ||
    value === "jitterSaved" ||
    value === "loss";
}

function isBenchmarkOneWaySortField(value: string | undefined): value is BenchmarkOneWaySortField {
  return value === "route" ||
    value === "doublezeroOneWay" ||
    value === "internetOneWay" ||
    value === "oneWayImprovement" ||
    value === "oneWaySaved" ||
    value === "oneWayClockError" ||
    value === "doublezeroOneWayJitter" ||
    value === "internetOneWayJitter" ||
    value === "oneWayJitterImprovement" ||
    value === "oneWayJitterSaved" ||
    value === "ingressDzOneWay" ||
    value === "egressDzOneWay";
}

function benchmarkRttDefaultSortDirection(field: BenchmarkRttSortField): SortDirection {
  return field === "improvement" || field === "rttSaved" || field === "jitterImprovement" || field === "jitterSaved" ? "desc" : "asc";
}

function benchmarkOneWayDefaultSortDirection(field: BenchmarkOneWaySortField): SortDirection {
  return field === "oneWayImprovement" || field === "oneWaySaved" || field === "oneWayJitterImprovement" || field === "oneWayJitterSaved" ? "desc" : "asc";
}

function appNav(view: AppView): string {
  return `
    <nav class="app-nav" aria-label="Primary">
      <a href="/" data-view="dashboard" class="${view === "dashboard" ? "active" : ""}">Dashboard</a>
      <a href="/create-config" data-view="create-config" class="${view === "create-config" ? "active" : ""}">Create config</a>
      <a href="/benchmarks" data-view="benchmarks" class="${view === "benchmarks" ? "active" : ""}">Benchmarks</a>
      <a href="/trading/cex">Trading latency</a>
      <a href="/billing" data-view="billing" class="${view === "billing" ? "active" : ""}">Billing</a>
      ${latestAdminBilling ? `<a href="/admin/billing" data-view="admin-billing" class="${view === "admin-billing" ? "active" : ""}">Admin</a>` : ""}
    </nav>
  `;
}

function authNav(view: AppView): string {
  return `
    <nav class="app-nav" aria-label="Authentication">
      <a href="/benchmarks" data-view="benchmarks" class="${view === "benchmarks" ? "active" : ""}">Benchmarks</a>
      <a href="/trading/cex">Trading latency</a>
      <a href="/login" data-view="login" class="${view === "login" ? "active" : ""}">Log in</a>
      <a href="/register" data-view="register" class="${view === "register" ? "active" : ""}">Register</a>
    </nav>
  `;
}

function dashboardView(state: { gates: Gate[]; sessions: Session[]; benchmarkMatrix: BenchmarkMatrix | null }): string {
  return `
    <section class="panel primary-panel">
      <div class="panel-heading">
        <h2>VPN configs</h2>
        <a class="button-link" href="/create-config" data-view="create-config">Create config</a>
      </div>
      ${vpnConfigsPanel(state.sessions)}
    </section>

    <section class="panel secondary-panel">
      <div class="panel-heading">
        <h2>Gates</h2>
      </div>
      ${gatesPanel(state.gates, state.benchmarkMatrix)}
    </section>
  `;
}

function billingView(billing: BillingSummary | null): string {
  return `
    <section class="panel primary-panel">
      <div class="panel-heading">
        <h2>Billing</h2>
        <button id="refresh-billing" class="secondary-button" type="button">Refresh deposits</button>
      </div>
      ${accountPanel(billing)}
      <p class="support-contact">Need test credits or billing help? <a href="mailto:gatekeepers@hyperspace.zone">gatekeepers@hyperspace.zone</a></p>
    </section>
  `;
}

function headerBalance(billing: BillingSummary | null): string {
  const amount = billingBalanceText(billing);
  return `
    <a class="identity-balance" href="/billing" data-view="billing" aria-label="Billing balance ${escapeHtml(amount)}">
      <small>Balance</small>
      <strong>${escapeHtml(amount)}</strong>
    </a>
  `;
}

function benchmarksView(state: { gates: Gate[]; benchmarkMatrix: BenchmarkMatrix | null }): string {
  return `
    <section class="panel secondary-panel">
      <div class="panel-heading">
        <h2>Benchmarks</h2>
        <small>${benchmarkFreshness(state.benchmarkMatrix)}</small>
      </div>
      ${benchmarkMatrixPanel(state.gates, state.benchmarkMatrix)}
    </section>
  `;
}

function createConfigView(gates: Gate[]): string {
  const title = createConfigStep === "result"
    ? createdConfigQrSvg ? "VPN config ready" : "Creating VPN config"
    : createConfigStep === "confirm" ? "Review VPN config" : "Create VPN config";
  return `
    <section class="panel primary-panel">
      <div class="panel-heading">
        <h2>${title}</h2>
        ${createConfigStep === "result" ? "" : '<a class="button-link secondary-button" href="/" data-view="dashboard">Dashboard</a>'}
      </div>
      ${createConfigStep === "result"
        ? createConfigResultPanel()
        : createConfigStep === "confirm" ? createConfigConfirmationPanel(gates) : createSessionPanel(gates)}
    </section>
  `;
}

function loginView(): string {
  return `
    <section class="panel auth-panel">
      <form id="email-code-request-form" class="auth-form">
        <div>
          <h2>Log in</h2>
          <p>Use an email code or Google account to manage issued WireGuard configs.</p>
        </div>
        <label>Email <input name="email" type="email" autocomplete="email" required value="${escapeHtml(emailOtpPendingEmail)}" /></label>
        <button type="submit" ${emailOtpBusy ? "disabled" : ""}>${emailOtpBusy ? "Sending..." : "Send code"}</button>
      </form>
      ${emailOtpPendingEmail ? `
        <form id="email-code-verify-form" class="auth-form auth-subform">
          <label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code" minlength="6" maxlength="6" required /></label>
          <button type="submit" ${emailOtpBusy ? "disabled" : ""}>${emailOtpBusy ? "Checking..." : "Verify code"}</button>
        </form>
      ` : ""}
      <button id="google-login" class="secondary-button auth-provider-button" type="button" ${googleLoginBusy ? "disabled" : ""}>${googleLoginBusy ? "Opening Google..." : "Continue with Google"}</button>
      <div class="auth-divider"><span>or password</span></div>
      <form id="login-form" class="auth-form">
        <label>Email <input name="email" type="email" autocomplete="email" required /></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required /></label>
        <button type="submit">Log in</button>
        <p class="auth-switch">No account yet? <a href="/register" data-view="register">Register</a></p>
      </form>
    </section>
  `;
}

function registerView(): string {
  return `
    <section class="panel auth-panel">
      <form id="register-form" class="auth-form">
        <div>
          <h2>Register</h2>
          <p>Create an account to issue and revoke DoubleZero WireGuard VPN configs.</p>
        </div>
        <label>Email <input name="email" type="email" autocomplete="email" required /></label>
        <label>Password <input name="password" type="password" autocomplete="new-password" minlength="12" required /></label>
        <button type="submit">Register</button>
        <p class="auth-switch">Already have an account? <a href="/login" data-view="login">Log in</a></p>
      </form>
    </section>
  `;
}

function accountPanel(billing: BillingSummary | null): string {
  const deposit = billing?.deposit ?? null;
  const nativeSolBilling = deposit?.tokenSymbol === "SOL" && deposit.tokenMint === "native";
  return `
    <div class="account-grid">
      <div class="account-card">
        <h3>${nativeSolBilling ? "Spendable balance" : "Balance"}</h3>
        <strong class="balance-value">${escapeHtml(billingBalanceText(billing))}</strong>
        <small>${nativeSolBilling && billing ? `Total ${escapeHtml(formatTokenBaseUnits(billing.walletBalanceBaseUnits ?? "0", deposit.tokenDecimals))} SOL · rent reserve ${escapeHtml(formatTokenBaseUnits(billing.walletRentReserveBaseUnits ?? "0", deposit.tokenDecimals))} SOL` : billing ? `${escapeHtml(billing.state.state)} · ${escapeHtml(billing.plan.displayName)} v${billing.plan.version}` : "Billing is loading"}</small>
        ${billing && !nativeSolBilling ? `<small>Paid ${escapeHtml(formatMoneyMinor(billing.buckets.cashMinor, billing.currency))} · Credits ${escapeHtml(formatMoneyMinor(billing.buckets.promotionalMinor, billing.currency))}${billing.buckets.debtMinor ? ` · Debt ${escapeHtml(formatMoneyMinor(billing.buckets.debtMinor, billing.currency))}` : ""}</small>` : ""}
      </div>
      <div class="account-card deposit-card">
        <h3>Deposit ${escapeHtml(deposit?.tokenSymbol ?? "SOL")}</h3>
        ${deposit ? `
          <div class="deposit-wallet">
            <div class="deposit-qr" role="img" aria-label="Solana deposit address QR code">${deposit.qrSvg}</div>
            <div class="deposit-details">
              <small>Network</small><strong>Solana</strong>
              <small>Asset</small><strong>${escapeHtml(deposit.tokenSymbol)}</strong>
              <small>Deposit address</small>
              <p class="mono wallet-row" title="${escapeHtml(deposit.address)}">${escapeHtml(deposit.address)}</p>
              <button type="button" data-copy-wallet="${escapeHtml(deposit.address)}">Copy address</button>
            </div>
          </div>
          <small>Send only ${escapeHtml(deposit.tokenSymbol)} on Solana. Any amount is accepted and credited after finalization.</small>
        ` : '<p class="empty-marker">Deposit wallet is being prepared</p>'}
      </div>
    </div>
    ${depositHistoryPanel(billing?.deposits ?? [], nativeSolBilling)}
    ${nativeSolBilling ? "" : withdrawalPanel(billing)}
    ${nativeSolBilling ? "" : billingUsagePanel(billing?.usage ?? [], billing?.currency ?? "USD")}
    ${nativeSolBilling ? "" : billingLedgerPanel(billing?.ledger ?? [], billing?.currency ?? "USD")}
  `;
}

function withdrawalPanel(billing: BillingSummary | null): string {
  if (!billing) return "";
  return `
    <div class="billing-ledger">
      <h3>Withdraw unused paid balance</h3>
      <p class="compact-copy">Revoke all VPN configs first. A ${escapeHtml(formatDurationSeconds(billing.plan.withdrawalCooldownSeconds))} cooldown lets final usage settle. Promotional credits cannot be withdrawn.</p>
      <form id="withdrawal-form" class="withdrawal-form">
        <label>Amount, USD <input name="amountUsd" inputmode="decimal" required /></label>
        <label>Solana destination <input name="destinationAddress" class="mono" autocomplete="off" minlength="32" required /></label>
        <button type="submit" ${withdrawalBusy ? "disabled" : ""}>${withdrawalBusy ? "Requesting..." : "Request withdrawal"}</button>
      </form>
      <small>Available ${escapeHtml(formatMoneyMinor(billing.withdrawableBalanceMinor, billing.currency))}</small>
      ${billing.withdrawals.map((withdrawal) => `
        <div class="billing-ledger-row">
          <div><strong>${escapeHtml(formatMoneyMinor(withdrawal.amountMinor, withdrawal.currency))} · ${escapeHtml(withdrawal.status)}</strong><small>Eligible ${escapeHtml(relativeTime(withdrawal.eligibleAt))} · ${escapeHtml(shortWallet(withdrawal.destinationAddress))}</small></div>
          ${["cooldown", "ready", "failed"].includes(withdrawal.status) ? `<button type="button" data-cancel-withdrawal="${escapeHtml(withdrawal.id)}">Cancel</button>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

function depositHistoryPanel(deposits: BillingDeposit[], nativeSolBilling = false): string {
  return `
    <div class="billing-ledger deposit-history">
      <div class="panel-heading"><h3>Deposit history</h3><small>${deposits.length ? `${deposits.length} finalized` : "No deposits yet"}</small></div>
      ${deposits.length ? `
        <div class="table-scroll"><table>
          <thead><tr><th>Received</th><th>Amount</th>${nativeSolBilling ? "" : "<th>Credited</th>"}<th>Status</th><th>Transaction</th></tr></thead>
          <tbody>${deposits.map((deposit) => `
            <tr>
              <td>${escapeHtml(relativeTime(deposit.observedAt))}</td>
              <td><strong>${escapeHtml(formatTokenBaseUnits(deposit.tokenAmountBaseUnits, deposit.tokenDecimals))} ${escapeHtml(deposit.tokenSymbol)}</strong></td>
              ${nativeSolBilling ? "" : `<td>${escapeHtml(formatMoneyMinor(deposit.creditedAmountMinor, deposit.currency))}</td>`}
              <td><span class="ok">Finalized</span></td>
              <td><a href="${escapeHtml(deposit.explorerUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(deposit.transactionSignature)}">${escapeHtml(shortTransaction(deposit.transactionSignature))}</a></td>
            </tr>
          `).join("")}</tbody>
        </table></div>
      ` : ""}
    </div>
  `;
}

function billingUsagePanel(usage: BillingUsageSummary[], currency: string): string {
  if (usage.length === 0) return "";
  return `
    <div class="billing-ledger">
      <h3>Usage by VPN config</h3>
      <div class="table-scroll"><table>
        <thead><tr><th>Config</th><th>Active time</th><th>Payload traffic</th><th>Charged</th><th>Last rated</th></tr></thead>
        <tbody>${usage.map((row) => {
          const bytes = BigInt(row.bytesToDestination) + BigInt(row.bytesFromDestination);
          return `<tr><td>${escapeHtml(row.sessionLabel || row.sessionId.slice(0, 8))}</td><td>${escapeHtml(formatDurationSeconds(row.activeSeconds))}</td><td>${escapeHtml(formatByteCount(bytes))}</td><td>${escapeHtml(formatMoneyMinor(row.chargeMinor, currency))}</td><td>${escapeHtml(relativeTime(row.lastRatedAt))}</td></tr>`;
        }).join("")}</tbody>
      </table></div>
    </div>
  `;
}

function adminBillingView(summary: AdminBillingSummary | null): string {
  if (!summary) return `<section class="panel primary-panel"><h2>Admin</h2><p>Billing administrator access is required.</p></section>`;
  const activeConfigs = summary.configs.filter(adminConfigIsActive);
  const visibleConfigs = filterAdminConfigs(summary.configs);
  const confirmedPayments = summary.payments.filter((payment) => payment.status === "confirmed");
  const confirmedRevenue = confirmedPayments.reduce((total, payment) => total + safeBigInt(payment.amountLamports), 0n);
  const totalPayload = summary.configs.reduce((total, config) => total + safeBigInt(config.payloadBytes), 0n);
  const totalDeposits = summary.deposits.reduce((total, deposit) => total + safeBigInt(deposit.amountBaseUnits), 0n);
  const treasuryBalance = summary.treasury.status === "available" && summary.treasury.balanceBaseUnits !== null
    ? `${formatTokenBaseUnits(summary.treasury.balanceBaseUnits, summary.asset.decimals)} ${summary.asset.symbol}`
    : summary.treasury.status === "not_configured" ? "Not configured" : "Unavailable";
  const treasuryAddress = summary.treasury.address || "";
  const configOptions = summary.configs.map((config) => {
    const label = config.label?.trim() || config.sessionId.slice(0, 8);
    const selected = adminTrafficSessionId === config.sessionId ? "selected" : "";
    return `<option value="${escapeHtml(config.sessionId)}" ${selected}>${escapeHtml(`${label} · ${config.customerEmail}`)}</option>`;
  }).join("");
  return `
    <section class="panel primary-panel">
      <div class="panel-heading"><h2>Network admin</h2><small>All customer accounts</small></div>
      <div class="admin-metric-strip">
        <div><small>Customers</small><strong>${summary.customers.length}</strong></div>
        <div><small>Active configs</small><strong>${activeConfigs.length}</strong></div>
        <div title="${escapeHtml(treasuryAddress)}"><small>Treasury balance</small><strong>${escapeHtml(treasuryBalance)}</strong>${treasuryAddress ? `<small class="mono">${escapeHtml(shortWallet(treasuryAddress))}</small>` : ""}</div>
        <div><small>Confirmed config revenue</small><strong>${escapeHtml(formatTokenBaseUnits(confirmedRevenue.toString(), summary.asset.decimals))} ${escapeHtml(summary.asset.symbol)}</strong></div>
        <div><small>Observed payload</small><strong>${escapeHtml(formatByteCount(totalPayload))}</strong></div>
        <div><small>Finalized deposits</small><strong>${escapeHtml(formatTokenBaseUnits(totalDeposits.toString(), summary.asset.decimals))} ${escapeHtml(summary.asset.symbol)}</strong></div>
      </div>
    </section>

    <section class="panel secondary-panel admin-traffic-panel">
      <div class="panel-heading"><h2>Traffic consumption</h2><small>Egress payload counters</small></div>
      <div class="admin-toolbar">
        <label>Config
          <select id="admin-traffic-config">
            <option value="">All configs</option>
            ${configOptions}
          </select>
        </label>
        <div class="segmented-control" aria-label="Traffic range">
          ${(["24h", "7d", "30d"] as const).map((range) => `<button type="button" data-admin-traffic-range="${range}" class="${adminTrafficRange === range ? "active" : "secondary-button"}">${range}</button>`).join("")}
        </div>
        <button id="refresh-admin-traffic" class="secondary-button" type="button" ${adminTrafficLoading ? "disabled" : ""}>${adminTrafficLoading ? "Refreshing..." : "Refresh"}</button>
      </div>
      ${adminTrafficChart(latestAdminTraffic, adminTrafficLoading)}
    </section>

    <section class="panel secondary-panel">
      <div class="panel-heading"><h2>VPN configs</h2><small>${visibleConfigs.length} of ${summary.configs.length}</small></div>
      <form id="admin-config-filters" class="admin-filter-row">
        <label>Search <input name="search" value="${escapeHtml(adminConfigSearch)}" placeholder="Email, config, gate or ID" /></label>
        <label>Show
          <select name="status">
            <option value="active" ${adminConfigFilter === "active" ? "selected" : ""}>Active configs</option>
            <option value="paid" ${adminConfigFilter === "paid" ? "selected" : ""}>Paid configs</option>
            <option value="payment-issue" ${adminConfigFilter === "payment-issue" ? "selected" : ""}>Payment issues</option>
            <option value="legacy" ${adminConfigFilter === "legacy" ? "selected" : ""}>No payment record</option>
            <option value="all" ${adminConfigFilter === "all" ? "selected" : ""}>All configs</option>
          </select>
        </label>
        <button type="submit">Apply</button>
      </form>
      <div class="table-scroll"><table>
        <thead><tr><th>Config</th><th>Customer</th><th>Route</th><th>State</th><th>Payment</th><th>Traffic</th><th>Last traffic</th><th>Created</th></tr></thead>
        <tbody>${visibleConfigs.length ? visibleConfigs.map((config) => adminConfigRow(config, summary.asset)).join("") : '<tr><td colspan="8" class="empty-marker">No configs match this filter.</td></tr>'}</tbody>
      </table></div>
    </section>

    <section class="panel secondary-panel">
      <div class="panel-heading"><h2>Config payments</h2><small>${confirmedPayments.length} confirmed</small></div>
      <div class="table-scroll"><table>
        <thead><tr><th>Time</th><th>Customer</th><th>Config</th><th>Amount</th><th>Network fee</th><th>Status</th><th>Transaction</th></tr></thead>
        <tbody>${summary.payments.length ? summary.payments.map((payment) => adminPaymentRow(payment, summary.asset)).join("") : '<tr><td colspan="7" class="empty-marker">No config payments recorded.</td></tr>'}</tbody>
      </table></div>
    </section>

    <section class="panel secondary-panel">
      <div class="panel-heading"><h2>Deposits</h2><small>${summary.deposits.length} finalized</small></div>
      <div class="table-scroll"><table>
        <thead><tr><th>Received</th><th>Customer</th><th>Wallet</th><th>Amount</th><th>Status</th><th>Transaction</th></tr></thead>
        <tbody>${summary.deposits.length ? summary.deposits.map((deposit) => adminDepositRow(deposit, summary.asset)).join("") : '<tr><td colspan="6" class="empty-marker">No deposits recorded.</td></tr>'}</tbody>
      </table></div>
    </section>

  `;
}

function adminConfigIsActive(config: AdminBillingConfig): boolean {
  return !config.hiddenAt && config.desiredState !== "Revoked" && !["revoked", "failed"].includes(config.phase);
}

function filterAdminConfigs(configs: AdminBillingConfig[]): AdminBillingConfig[] {
  const search = adminConfigSearch.trim().toLowerCase();
  return configs.filter((config) => {
    const matchesState = adminConfigFilter === "all"
      || (adminConfigFilter === "active" && adminConfigIsActive(config))
      || (adminConfigFilter === "paid" && config.paymentStatus === "confirmed")
      || (adminConfigFilter === "payment-issue" && Boolean(config.paymentStatus) && config.paymentStatus !== "confirmed")
      || (adminConfigFilter === "legacy" && !config.paymentStatus);
    if (!matchesState || !search) return matchesState;
    return [
      config.sessionId,
      config.label,
      config.customerEmail,
      config.ingressGateName,
      config.egressGateName,
      config.phase,
      config.paymentStatus
    ].some((value) => value?.toLowerCase().includes(search));
  });
}

function adminConfigRow(config: AdminBillingConfig, asset: AdminBillingAsset): string {
  const payment = config.paymentStatus
    ? `<span class="status-badge ${adminStatusClass(config.paymentStatus)}">${escapeHtml(config.paymentStatus)}</span>${config.paymentAmountLamports ? `<small>${escapeHtml(formatTokenBaseUnits(config.paymentAmountLamports, asset.decimals))} ${escapeHtml(asset.symbol)}</small>` : ""}`
    : '<span class="status-badge neutral">no payment</span><small>No config payment record</small>';
  return `<tr data-admin-config-row="${escapeHtml(config.sessionId)}">
    <td><strong>${escapeHtml(config.label?.trim() || config.sessionId.slice(0, 8))}</strong><small class="mono">${escapeHtml(config.sessionId)}</small><small>${escapeHtml(config.mode)}</small></td>
    <td>${escapeHtml(config.customerEmail)}</td>
    <td>${escapeHtml(config.ingressGateName || "n/a")} → ${escapeHtml(config.egressGateName || "n/a")}</td>
    <td><span class="status-badge ${adminStatusClass(config.phase)}">${escapeHtml(config.phase)}</span><small>${escapeHtml(formatDurationSeconds(config.activeSeconds))}</small></td>
    <td>${payment}</td>
    <td><strong>${escapeHtml(formatByteCount(safeBigInt(config.payloadBytes)))}</strong><small>out ${escapeHtml(formatByteCount(safeBigInt(config.bytesToDestination)))} · in ${escapeHtml(formatByteCount(safeBigInt(config.bytesFromDestination)))}</small>${safeBigInt(config.droppedBytes) > 0n ? `<small class="amount-debit">dropped ${escapeHtml(formatByteCount(safeBigInt(config.droppedBytes)))}</small>` : ""}</td>
    <td>${config.lastTrafficAt ? escapeHtml(relativeTime(config.lastTrafficAt)) : "No traffic"}</td>
    <td>${escapeHtml(relativeTime(config.createdAt))}</td>
  </tr>`;
}

function adminPaymentRow(payment: AdminConfigPayment, asset: AdminBillingAsset): string {
  const transaction = payment.transactionSignature
    ? `<a href="${escapeHtml(`${asset.explorerTransactionBaseUrl}${payment.transactionSignature}`)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortTransaction(payment.transactionSignature))}</a>`
    : "Not submitted";
  const time = payment.confirmedAt || payment.submittedAt || payment.createdAt;
  return `<tr>
    <td>${escapeHtml(relativeTime(time))}</td>
    <td>${escapeHtml(payment.customerEmail)}</td>
    <td><strong>${escapeHtml(payment.sessionLabel?.trim() || payment.sessionId?.slice(0, 8) || "pending")}</strong>${payment.sessionId ? `<small class="mono">${escapeHtml(payment.sessionId)}</small>` : ""}</td>
    <td>${escapeHtml(formatTokenBaseUnits(payment.amountLamports, asset.decimals))} ${escapeHtml(asset.symbol)}</td>
    <td>${payment.feeLamports ? `${escapeHtml(formatTokenBaseUnits(payment.feeLamports, asset.decimals))} ${escapeHtml(asset.symbol)}` : "n/a"}</td>
    <td><span class="status-badge ${adminStatusClass(payment.status)}" title="${escapeHtml(payment.failureReason || payment.failureCode || "")}">${escapeHtml(payment.status)}</span></td>
    <td>${transaction}</td>
  </tr>`;
}

function adminDepositRow(deposit: AdminDeposit, asset: AdminBillingAsset): string {
  const amount = deposit.amountBaseUnits ?? String(deposit.creditedAmountMinor);
  return `<tr>
    <td>${escapeHtml(relativeTime(deposit.observedAt))}</td>
    <td>${escapeHtml(deposit.customerEmail)}</td>
    <td class="mono" title="${escapeHtml(deposit.walletAddress || "")}">${escapeHtml(deposit.walletAddress ? shortWallet(deposit.walletAddress) : "n/a")}</td>
    <td><strong>${escapeHtml(formatTokenBaseUnits(amount, asset.decimals))} ${escapeHtml(asset.symbol)}</strong></td>
    <td><span class="status-badge confirmed">finalized</span></td>
    <td><a href="${escapeHtml(`${asset.explorerTransactionBaseUrl}${deposit.transactionSignature}`)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortTransaction(deposit.transactionSignature))}</a></td>
  </tr>`;
}

function adminTrafficChart(series: AdminTrafficSeries | null, loading: boolean): string {
  if (loading && !series) return '<div class="admin-chart-empty">Loading traffic counters...</div>';
  const points = series?.points ?? [];
  if (points.length === 0) return '<div class="admin-chart-empty">No traffic was observed in this time range.</div>';
  const width = 1000;
  const height = 240;
  const left = 54;
  const right = 18;
  const top = 18;
  const bottom = 34;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const outbound = points.map((point) => Number(safeBigInt(point.bytesToDestination)));
  const inbound = points.map((point) => Number(safeBigInt(point.bytesFromDestination)));
  const dropped = points.map((point) => Number(safeBigInt(point.droppedBytes)));
  const maxValue = Math.max(1, ...outbound, ...inbound, ...dropped);
  const polyline = (values: number[]) => values.map((value, index) => {
    const x = left + (values.length === 1 ? plotWidth / 2 : index * plotWidth / (values.length - 1));
    const y = top + plotHeight - (value / maxValue) * plotHeight;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const total = points.reduce((sum, point) => sum + safeBigInt(point.bytesToDestination) + safeBigInt(point.bytesFromDestination), 0n);
  return `<div class="admin-chart-wrap">
    <div class="admin-chart-legend"><span class="outbound">To destination</span><span class="inbound">From destination</span><span class="dropped">Dropped</span><strong>${escapeHtml(formatByteCount(total))} total</strong></div>
    <svg class="admin-traffic-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Traffic consumption over ${escapeHtml(series?.range || adminTrafficRange)}">
      <line x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}" class="chart-axis" />
      <line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}" class="chart-axis" />
      ${[0.25, 0.5, 0.75].map((ratio) => `<line x1="${left}" y1="${(top + plotHeight * ratio).toFixed(1)}" x2="${width - right}" y2="${(top + plotHeight * ratio).toFixed(1)}" class="chart-grid" />`).join("")}
      <polyline points="${polyline(outbound)}" class="chart-line outbound" />
      <polyline points="${polyline(inbound)}" class="chart-line inbound" />
      <polyline points="${polyline(dropped)}" class="chart-line dropped" />
      <text x="${left}" y="${height - 10}" class="chart-label">${escapeHtml(new Date(series?.from || "").toLocaleString())}</text>
      <text x="${width - right}" y="${height - 10}" text-anchor="end" class="chart-label">${escapeHtml(new Date(series?.to || "").toLocaleString())}</text>
      <text x="${left - 8}" y="${top + 4}" text-anchor="end" class="chart-label">${escapeHtml(formatByteCount(BigInt(Math.round(maxValue))))}</text>
    </svg>
  </div>`;
}

function adminStatusClass(status: string): string {
  if (["confirmed", "active", "succeeded"].includes(status)) return "confirmed";
  if (["failed", "revoked", "dead"].includes(status)) return "failed";
  if (["pending", "processing", "submitted", "payment_pending", "requested", "provisioning"].includes(status)) return "pending";
  return "neutral";
}

function safeBigInt(value: string | number | bigint | null | undefined): bigint {
  try {
    return BigInt(value ?? 0);
  } catch {
    return 0n;
  }
}

function billingLedgerPanel(entries: BillingLedgerEntry[], currency: string): string {
  if (entries.length === 0) {
    return "";
  }
  return `
    <div class="billing-ledger">
      <h3>Recent balance activity</h3>
      ${entries.slice(0, 10).map((entry) => `
        <div class="billing-ledger-row">
          <div><strong>${escapeHtml(entry.description || entry.entryType)}</strong><small>${escapeHtml(relativeTime(entry.createdAt))}</small></div>
          <strong class="${entry.amountMinor < 0 ? "amount-debit" : "amount-credit"}">${entry.amountMinor > 0 ? "+" : ""}${escapeHtml(formatMoneyMinor(entry.amountMinor, entry.currency || currency))}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function gatesPanel(gates: Gate[], benchmarkMatrix: BenchmarkMatrix | null): string {
  if (gates.length === 0) {
    return "<p>No gates loaded.</p>";
  }
  const showClockError = shouldShowGateClockError();
  const effectiveSortField = showClockError ? gateSortField : "browser-rtt";
  const effectiveSortDirection = gateSortDirection(effectiveSortField);
  const sortedGates = sortGates(gates, effectiveSortField, effectiveSortDirection);
  const measureButtonLabel = gateLatencyMeasurementInFlight ? "Measuring..." : "Measure browser RTT";
  const measureButtonDisabled = gateLatencyMeasurementInFlight ? "disabled" : "";
  const sortLabel = effectiveSortDirection === "desc" ? "high to low" : "low to high";
  return `
    <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>City</th>
          <th>Country</th>
          <th>Public IPv4</th>
          <th>Ready</th>
          <th aria-sort="${gateAriaSort("browser-rtt", effectiveSortField)}">
            <button class="table-sort" type="button" data-sort-gates="browser-rtt">Browser RTT ${gateSortArrow("browser-rtt", effectiveSortField)}</button>
          </th>
          <th>Schedulable</th>
          <th>DoubleZero node</th>
          ${showClockError ? `
            <th aria-sort="${gateAriaSort("clock-error", effectiveSortField)}">
              <button class="table-sort" type="button" data-sort-gates="clock-error">Clock Error ${gateSortArrow("clock-error", effectiveSortField)}</button>
              ${benchmarkInfoIcon(gateClockErrorTooltip())}
            </th>
          ` : ""}
        </tr>
      </thead>
      <tbody>
        ${sortedGates
          .map(
            (gate) => `
              <tr>
                <td>${escapeHtml(gate.name)}</td>
                <td>${escapeHtml(gate.city?.trim() || "unknown")}</td>
                <td>${escapeHtml(gate.country || "unknown")}</td>
                <td><small class="mono">${escapeHtml(gate.publicIpv4)}</small></td>
                <td>${statusDot(gate.ready)}</td>
                <td class="latency-cell">${latencyCell(gate)}</td>
                <td>${statusDot(gate.schedulable)}</td>
                <td>${doubleZeroNodeCell(gate)}</td>
                ${showClockError ? `<td class="numeric-cell">${gateClockErrorCell(gate.clockErrorMs)}</td>` : ""}
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
    </div>
    <div class="panel-actions">
      <button id="measure-gates" type="button" ${measureButtonDisabled}>${measureButtonLabel}</button>
      <small>Sorted by ${gateSortLabel(effectiveSortField)}, ${sortLabel}.</small>
    </div>
  `;
}

function shouldShowGateClockError(): boolean {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("showclockerror") ?? params.get("showClockError") ?? params.get("clockerror");
  return value !== null && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function gateSortDirection(field: GateSortField): SortDirection {
  return field === "clock-error" ? gateClockErrorSortDirection : gateBrowserRttSortDirection;
}

function gateSortArrow(field: GateSortField, activeField: GateSortField): string {
  if (field !== activeField) {
    return "";
  }
  return gateSortDirection(field) === "desc" ? "↓" : "↑";
}

function gateAriaSort(field: GateSortField, activeField: GateSortField): string {
  if (field !== activeField) {
    return "none";
  }
  return gateSortDirection(field) === "desc" ? "descending" : "ascending";
}

function gateSortLabel(field: GateSortField): string {
  return field === "clock-error" ? "Clock Error" : "Browser RTT";
}

function gateClockErrorTooltip(): string {
  return "Debug-only per-gate Clock Error from the latest gate-agent heartbeat. It is a chrony-based NTP uncertainty estimate: abs(last offset) + RMS offset + root delay / 2 + root dispersion from chronyc tracking. Use ?showclockerror=true to show it.";
}

function gateClockErrorCell(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return '<span class="muted">n/a</span>';
  }
  return `<span class="gate-clock-error ${gateClockErrorClass(value)}">${escapeHtml(formatClockErrorMetricMs(value))}</span>`;
}

function gateClockErrorClass(value: number): string {
  if (value <= 3) {
    return "gate-clock-error-good";
  }
  if (value <= 10) {
    return "gate-clock-error-warning";
  }
  return "gate-clock-error-bad";
}

function averageFinite(values: number[]): number | undefined {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (finiteValues.length === 0) {
    return undefined;
  }
  return finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
}

function benchmarkMatrixPanel(gates: Gate[], matrix: BenchmarkMatrix | null): string {
  const rows = benchmarkRouteRows(gates, matrix);
  if (rows.length === 0) {
    return "<p>No benchmark route data available yet.</p>";
  }
  const filteredRows = filterBenchmarkRows(rows);
  const sortedRttRows = sortBenchmarkRttRows(filteredRows);
  const sortedOneWayRows = sortBenchmarkOneWayRows(filteredRows);
  const cityOptions = benchmarkCityOptions(rows);
  const summary = benchmarkSummary(rows, filteredRows);
  return `
    <div class="benchmark-routes">
      <div class="benchmark-routes-heading">
        <div>
          <h3>DZ vs Internet</h3>
          <p>Directed gate-to-gate latency comparison over DZ and Internet for each city pair.</p>
        </div>
        <div class="benchmark-summary" aria-label="Benchmark summary">
          <span><strong>${filteredRows.length}</strong> routes</span>
          <span><strong>${summary.publicSucceeded}</strong> internet ok</span>
          <span><strong>${summary.doublezeroSucceeded}</strong> DZ ok</span>
          <span><strong>${summary.doublezeroNotApplicable}</strong> DZ N/A</span>
          <span><strong>${formatSignedPercent(summary.averageImprovementPercent)}</strong> avg improvement</span>
        </div>
      </div>
      <div class="benchmark-controls">
        <label class="benchmark-filter-label">
          City filter
          <select id="benchmark-city-filter">
            <option value="" ${benchmarkCityFilter === "" ? "selected" : ""}>All cities</option>
            ${cityOptions.map((city) => `<option value="${escapeHtml(city)}" ${benchmarkCityFilter === city ? "selected" : ""}>${escapeHtml(city)}</option>`).join("")}
          </select>
        </label>
        <small>${benchmarkCityFilter ? `Showing routes touching ${escapeHtml(benchmarkCityFilter)}.` : "Showing all directed routes."}</small>
      </div>
      <section class="benchmark-table-section">
        <div class="benchmark-table-heading">
          <h3>Gate benchmark routes — RTT</h3>
        </div>
        ${benchmarkRttRoutesTable(sortedRttRows)}
      </section>
      <section class="benchmark-table-section">
        <div class="benchmark-table-heading">
          <h3>Gate benchmark routes — One-Way</h3>
        </div>
        ${benchmarkOneWayRoutesTable(sortedOneWayRows)}
      </section>
      ${benchmarkLegend()}
    </div>
  `;
}

function benchmarkRttRoutesTable(rows: BenchmarkRouteRow[]): string {
  if (rows.length === 0) {
    return '<p class="empty-state-text">No routes match the selected city filter.</p>';
  }
  return `
    <div class="table-scroll">
      <table class="benchmark-route-table benchmark-rtt-table">
        <thead>
          <tr>
            ${benchmarkRttSortableHeader("Route", "route", "left")}
            ${benchmarkRttSortableHeader("DZ RTT", "doublezeroRtt", "right")}
            ${benchmarkRttSortableHeader("Internet RTT", "internetRtt", "right")}
            ${benchmarkRttSortableHeader("RTT Improvement", "improvement", "right")}
            ${benchmarkRttSortableHeader("RTT Saved", "rttSaved", "right")}
            ${benchmarkRttSortableHeader("DZ RTT Jitter", "doublezeroJitter", "right")}
            ${benchmarkRttSortableHeader("Internet RTT Jitter", "internetJitter", "right")}
            ${benchmarkRttSortableHeader("RTT Jitter Improvement", "jitterImprovement", "right")}
            ${benchmarkRttSortableHeader("RTT Jitter Saved", "jitterSaved", "right")}
            ${benchmarkRttSortableHeader("Loss", "loss", "right")}
            ${benchmarkRttSortableHeader("Ingress gate ↔ DZ RTT", "ingressDzRtt", "right")}
            ${benchmarkRttSortableHeader("Egress gate ↔ DZ RTT", "egressDzRtt", "right")}
          </tr>
        </thead>
        <tbody>
          ${rows.map(benchmarkRttRouteRow).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function benchmarkRttRouteRow(row: BenchmarkRouteRow): string {
  const route = row.route;
  return `
    <tr>
      <td>
        <div class="route-pair">
          <strong>${escapeHtml(row.sourceCity)}</strong>
          <span aria-hidden="true">→</span>
          <strong>${escapeHtml(row.targetCity)}</strong>
        </div>
        <small>${escapeHtml(row.routeLabel)}</small>
      </td>
      <td class="numeric-cell">${benchmarkDoublezeroValueCell(route, formatMetricMs(row.doublezeroRttMs))}</td>
      <td class="numeric-cell">${benchmarkValueCell(route.public, formatMetricMs(row.publicRttMs))}</td>
      <td class="numeric-cell">${benchmarkImprovementCell(row.rttImprovementPercent)}</td>
      <td class="numeric-cell">${formatSavedMetricMs(row.rttSavedMs)}</td>
      <td class="numeric-cell">${benchmarkDoublezeroValueCell(route, formatJitterMetricMs(row.doublezeroJitterMs))}</td>
      <td class="numeric-cell">${benchmarkValueCell(route.public, formatJitterMetricMs(row.publicJitterMs))}</td>
      <td class="numeric-cell">${benchmarkImprovementCell(row.jitterImprovementPercent)}</td>
      <td class="numeric-cell">${formatSavedJitterMetricMs(row.jitterSavedMs)}</td>
      <td class="numeric-cell">${benchmarkLossCell(route, row)}</td>
      <td class="numeric-cell">${benchmarkEdgeRttCell(row.sourceGate, row.ingressDzRttMs)}</td>
      <td class="numeric-cell">${benchmarkEdgeRttCell(row.targetGate, row.egressDzRttMs)}</td>
    </tr>
  `;
}

function benchmarkOneWayRoutesTable(rows: BenchmarkRouteRow[]): string {
  if (rows.length === 0) {
    return '<p class="empty-state-text">No routes match the selected city filter.</p>';
  }
  return `
    <div class="table-scroll">
      <table class="benchmark-route-table benchmark-one-way-table">
        <thead>
          <tr>
            ${benchmarkOneWaySortableHeader("Route", "route", "left")}
            ${benchmarkOneWaySortableHeader("DZ One-Way", "doublezeroOneWay", "right")}
            ${benchmarkOneWaySortableHeader("Internet One-Way", "internetOneWay", "right")}
            ${benchmarkOneWaySortableHeader("One-Way Improvement", "oneWayImprovement", "right")}
            ${benchmarkOneWaySortableHeader("One-Way Saved", "oneWaySaved", "right")}
            ${benchmarkOneWaySortableHeader("Clock Error", "oneWayClockError", "right", oneWayClockErrorTooltip())}
            ${benchmarkOneWaySortableHeader("DZ Jitter", "doublezeroOneWayJitter", "right")}
            ${benchmarkOneWaySortableHeader("Internet Jitter", "internetOneWayJitter", "right")}
            ${benchmarkOneWaySortableHeader("Jitter Improvement", "oneWayJitterImprovement", "right")}
            ${benchmarkOneWaySortableHeader("Jitter Saved", "oneWayJitterSaved", "right")}
            ${benchmarkOneWaySortableHeader("Ingress gate → DZ", "ingressDzOneWay", "right", edgeOneWayEstimateTooltip())}
            ${benchmarkOneWaySortableHeader("DZ → Egress gate", "egressDzOneWay", "right", edgeOneWayEstimateTooltip())}
          </tr>
        </thead>
        <tbody>
          ${rows.map(benchmarkOneWayRouteRow).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function benchmarkOneWayRouteRow(row: BenchmarkRouteRow): string {
  const route = row.route;
  return `
    <tr>
      <td>
        <div class="route-pair">
          <strong>${escapeHtml(row.sourceCity)}</strong>
          <span aria-hidden="true">→</span>
          <strong>${escapeHtml(row.targetCity)}</strong>
        </div>
        <small>${escapeHtml(row.routeLabel)}</small>
      </td>
      <td class="numeric-cell">${benchmarkDoublezeroValueCell(route, formatMetricMs(row.doublezeroOneWayMs))}</td>
      <td class="numeric-cell">${benchmarkValueCell(route.public, formatMetricMs(row.publicOneWayMs))}</td>
      <td class="numeric-cell">${benchmarkImprovementCell(row.oneWayImprovementPercent)}</td>
      <td class="numeric-cell">${formatSavedMetricMs(row.oneWaySavedMs)}</td>
      <td class="numeric-cell">${benchmarkOneWayClockErrorCell(route, row)}</td>
      <td class="numeric-cell">${benchmarkDoublezeroValueCell(route, formatJitterMetricMs(row.doublezeroOneWayJitterMs))}</td>
      <td class="numeric-cell">${benchmarkValueCell(route.public, formatJitterMetricMs(row.publicOneWayJitterMs))}</td>
      <td class="numeric-cell">${benchmarkImprovementCell(row.oneWayJitterImprovementPercent)}</td>
      <td class="numeric-cell">${formatSavedJitterMetricMs(row.oneWayJitterSavedMs)}</td>
      <td class="numeric-cell">${benchmarkEdgeOneWayEstimateCell(row.sourceGate, row.ingressDzOneWayMs, "Ingress gate → DZ")}</td>
      <td class="numeric-cell">${benchmarkEdgeOneWayEstimateCell(row.targetGate, row.egressDzOneWayMs, "DZ → Egress gate")}</td>
    </tr>
  `;
}

function benchmarkRttSortableHeader(label: string, field: BenchmarkRttSortField, align: "left" | "right"): string {
  return benchmarkSortableHeader(label, field, align, "data-sort-benchmark-rtt", benchmarkRttSortField, benchmarkRttSortDirection);
}

function benchmarkOneWaySortableHeader(label: string, field: BenchmarkOneWaySortField, align: "left" | "right", infoTitle?: string): string {
  return benchmarkSortableHeader(label, field, align, "data-sort-benchmark-one-way", benchmarkOneWaySortField, benchmarkOneWaySortDirection, infoTitle);
}

function benchmarkSortableHeader(label: string, field: string, align: "left" | "right", sortAttribute: string, activeField: string, activeDirection: SortDirection, infoTitle?: string): string {
  const arrow = activeField === field ? (activeDirection === "desc" ? "↓" : "↑") : "";
  const info = infoTitle ? benchmarkInfoIcon(infoTitle) : "";
  return `
    <th class="${align === "right" ? "numeric-cell" : ""}" aria-sort="${benchmarkAriaSort(field, activeField, activeDirection)}">
      <button class="table-sort" type="button" ${sortAttribute}="${field}">
        ${escapeHtml(label)} ${info} ${arrow}
      </button>
    </th>
  `;
}

function benchmarkAriaSort(field: string, activeField: string, activeDirection: SortDirection): string {
  if (activeField !== field) {
    return "none";
  }
  return activeDirection === "desc" ? "descending" : "ascending";
}

function benchmarkRouteRows(gates: Gate[], matrix: BenchmarkMatrix | null): BenchmarkRouteRow[] {
  const source = matrix?.gates?.length ? matrix.gates : gates;
  const gateById = new Map(source.map((gate) => [gate.id, gate]));
  return (matrix?.routes ?? []).flatMap((route) => {
    const sourceGate = gateById.get(route.sourceGateId);
    const targetGate = gateById.get(route.targetGateId);
    if (!sourceGate || !targetGate || sourceGate.id === targetGate.id) {
      return [];
    }
    const publicRttMs = finiteNumber(route.public?.rttMs?.p50);
    const doublezeroRttMs = finiteNumber(route.doublezero?.rttMs?.p50);
    const ingressDzRttMs = finiteNumber(sourceGate.doubleZero?.edgeRttMs);
    const egressDzRttMs = finiteNumber(targetGate.doubleZero?.edgeRttMs);
    const ingressDzOneWayMs = estimatedOneWayFromRtt(ingressDzRttMs);
    const egressDzOneWayMs = estimatedOneWayFromRtt(egressDzRttMs);
    const publicJitterMs = finiteNumber(route.public?.jitterMs);
    const doublezeroJitterMs = finiteNumber(route.doublezero?.jitterMs);
    const jitterSavedMs = typeof publicJitterMs === "number" && typeof doublezeroJitterMs === "number"
      ? compactMetric(publicJitterMs - doublezeroJitterMs)
      : undefined;
    const jitterImprovementPercent = typeof jitterSavedMs === "number" && typeof publicJitterMs === "number" && publicJitterMs > 0
      ? compactMetric((jitterSavedMs / publicJitterMs) * 100)
      : undefined;
    const publicLossPercent = finiteNumber(route.public?.lossPercent);
    const doublezeroLossPercent = finiteNumber(route.doublezero?.lossPercent);
    const publicOneWayMs = finiteNumber(route.public?.forwardOneWayMs?.p50);
    const doublezeroOneWayMs = finiteNumber(route.doublezero?.forwardOneWayMs?.p50);
    const publicOneWayClockErrorMs = oneWayClockErrorMs(route.public);
    const doublezeroOneWayClockErrorMs = oneWayClockErrorMs(route.doublezero);
    const oneWayClockErrorMsValue = maxOptionalMetric(publicOneWayClockErrorMs, doublezeroOneWayClockErrorMs);
    const publicOneWayJitterMs = summaryP95MinusP50(route.public?.forwardOneWayMs);
    const doublezeroOneWayJitterMs = summaryP95MinusP50(route.doublezero?.forwardOneWayMs);
    const oneWayJitterSavedMs = typeof publicOneWayJitterMs === "number" && typeof doublezeroOneWayJitterMs === "number"
      ? compactMetric(publicOneWayJitterMs - doublezeroOneWayJitterMs)
      : undefined;
    const oneWayJitterImprovementPercent = typeof oneWayJitterSavedMs === "number" && typeof publicOneWayJitterMs === "number" && publicOneWayJitterMs > 0
      ? compactMetric((oneWayJitterSavedMs / publicOneWayJitterMs) * 100)
      : undefined;
    const oneWaySavedMs = typeof publicOneWayMs === "number" && typeof doublezeroOneWayMs === "number"
      ? compactMetric(publicOneWayMs - doublezeroOneWayMs)
      : undefined;
    const oneWayImprovementPercent = typeof oneWaySavedMs === "number" && typeof publicOneWayMs === "number" && publicOneWayMs > 0
      ? compactMetric((oneWaySavedMs / publicOneWayMs) * 100)
      : undefined;
    const rttSavedMs = typeof publicRttMs === "number" && typeof doublezeroRttMs === "number"
      ? compactMetric(publicRttMs - doublezeroRttMs)
      : undefined;
    const rttImprovementPercent = typeof rttSavedMs === "number" && typeof publicRttMs === "number" && publicRttMs > 0
      ? compactMetric((rttSavedMs / publicRttMs) * 100)
      : undefined;
    const sourceCity = benchmarkCity(sourceGate);
    const targetCity = benchmarkCity(targetGate);
    return [{
      route,
      sourceGate,
      targetGate,
      routeLabel: `${route.sourceGateName} → ${route.targetGateName}`,
      cityLabel: `${sourceCity} → ${targetCity}`,
      sourceCity,
      targetCity,
      publicRttMs,
      doublezeroRttMs,
      ingressDzRttMs,
      egressDzRttMs,
      ingressDzOneWayMs,
      egressDzOneWayMs,
      publicJitterMs,
      doublezeroJitterMs,
      jitterSavedMs,
      jitterImprovementPercent,
      publicLossPercent,
      doublezeroLossPercent,
      publicOneWayMs,
      doublezeroOneWayMs,
      publicOneWayClockErrorMs,
      doublezeroOneWayClockErrorMs,
      oneWayClockErrorMs: oneWayClockErrorMsValue,
      publicOneWayJitterMs,
      doublezeroOneWayJitterMs,
      oneWayJitterSavedMs,
      oneWayJitterImprovementPercent,
      oneWaySavedMs,
      oneWayImprovementPercent,
      rttSavedMs,
      rttImprovementPercent
    }];
  });
}

function filterBenchmarkRows(rows: BenchmarkRouteRow[]): BenchmarkRouteRow[] {
  if (!benchmarkCityFilter) {
    return rows;
  }
  const filter = benchmarkCityFilter.toLowerCase();
  return rows.filter((row) => row.sourceCity.toLowerCase() === filter || row.targetCity.toLowerCase() === filter);
}

function sortBenchmarkRttRows(rows: BenchmarkRouteRow[]): BenchmarkRouteRow[] {
  return [...rows].sort((a, b) => {
    let cmp = 0;
    switch (benchmarkRttSortField) {
      case "route":
        cmp = a.cityLabel.localeCompare(b.cityLabel);
        break;
      case "doublezeroRtt":
        cmp = compareOptionalNumber(a.doublezeroRttMs, b.doublezeroRttMs, benchmarkRttSortDirection);
        break;
      case "internetRtt":
        cmp = compareOptionalNumber(a.publicRttMs, b.publicRttMs, benchmarkRttSortDirection);
        break;
      case "improvement":
        cmp = compareOptionalNumber(a.rttImprovementPercent, b.rttImprovementPercent, benchmarkRttSortDirection);
        break;
      case "rttSaved":
        cmp = compareOptionalNumber(a.rttSavedMs, b.rttSavedMs, benchmarkRttSortDirection);
        break;
      case "ingressDzRtt":
        cmp = compareOptionalNumber(a.ingressDzRttMs, b.ingressDzRttMs, benchmarkRttSortDirection);
        break;
      case "egressDzRtt":
        cmp = compareOptionalNumber(a.egressDzRttMs, b.egressDzRttMs, benchmarkRttSortDirection);
        break;
      case "doublezeroJitter":
        cmp = compareOptionalNumber(a.doublezeroJitterMs, b.doublezeroJitterMs, benchmarkRttSortDirection);
        break;
      case "internetJitter":
        cmp = compareOptionalNumber(a.publicJitterMs, b.publicJitterMs, benchmarkRttSortDirection);
        break;
      case "jitterImprovement":
        cmp = compareOptionalNumber(a.jitterImprovementPercent, b.jitterImprovementPercent, benchmarkRttSortDirection);
        break;
      case "jitterSaved":
        cmp = compareOptionalNumber(a.jitterSavedMs, b.jitterSavedMs, benchmarkRttSortDirection);
        break;
      case "loss":
        cmp = compareOptionalNumber(a.doublezeroLossPercent, b.doublezeroLossPercent, benchmarkRttSortDirection);
        break;
    }
    if (cmp === 0) {
      cmp = a.routeLabel.localeCompare(b.routeLabel);
    }
    if (benchmarkRttSortField === "route") {
      return benchmarkRttSortDirection === "asc" ? cmp : -cmp;
    }
    return cmp;
  });
}

function sortBenchmarkOneWayRows(rows: BenchmarkRouteRow[]): BenchmarkRouteRow[] {
  return [...rows].sort((a, b) => {
    let cmp = 0;
    switch (benchmarkOneWaySortField) {
      case "route":
        cmp = a.cityLabel.localeCompare(b.cityLabel);
        break;
      case "doublezeroOneWay":
        cmp = compareOptionalNumber(a.doublezeroOneWayMs, b.doublezeroOneWayMs, benchmarkOneWaySortDirection);
        break;
      case "internetOneWay":
        cmp = compareOptionalNumber(a.publicOneWayMs, b.publicOneWayMs, benchmarkOneWaySortDirection);
        break;
      case "oneWayImprovement":
        cmp = compareOptionalNumber(a.oneWayImprovementPercent, b.oneWayImprovementPercent, benchmarkOneWaySortDirection);
        break;
      case "oneWaySaved":
        cmp = compareOptionalNumber(a.oneWaySavedMs, b.oneWaySavedMs, benchmarkOneWaySortDirection);
        break;
      case "oneWayClockError":
        cmp = compareOptionalNumber(a.oneWayClockErrorMs, b.oneWayClockErrorMs, benchmarkOneWaySortDirection);
        break;
      case "doublezeroOneWayJitter":
        cmp = compareOptionalNumber(a.doublezeroOneWayJitterMs, b.doublezeroOneWayJitterMs, benchmarkOneWaySortDirection);
        break;
      case "internetOneWayJitter":
        cmp = compareOptionalNumber(a.publicOneWayJitterMs, b.publicOneWayJitterMs, benchmarkOneWaySortDirection);
        break;
      case "oneWayJitterImprovement":
        cmp = compareOptionalNumber(a.oneWayJitterImprovementPercent, b.oneWayJitterImprovementPercent, benchmarkOneWaySortDirection);
        break;
      case "oneWayJitterSaved":
        cmp = compareOptionalNumber(a.oneWayJitterSavedMs, b.oneWayJitterSavedMs, benchmarkOneWaySortDirection);
        break;
      case "ingressDzOneWay":
        cmp = compareOptionalNumber(a.ingressDzOneWayMs, b.ingressDzOneWayMs, benchmarkOneWaySortDirection);
        break;
      case "egressDzOneWay":
        cmp = compareOptionalNumber(a.egressDzOneWayMs, b.egressDzOneWayMs, benchmarkOneWaySortDirection);
        break;
    }
    if (cmp === 0) {
      cmp = a.routeLabel.localeCompare(b.routeLabel);
    }
    if (benchmarkOneWaySortField === "route") {
      return benchmarkOneWaySortDirection === "asc" ? cmp : -cmp;
    }
    return cmp;
  });
}

function compareOptionalNumber(a: number | undefined, b: number | undefined, direction: SortDirection): number {
  if (a == null && b == null) {
    return 0;
  }
  if (a == null) {
    return 1;
  }
  if (b == null) {
    return -1;
  }
  return direction === "asc" ? a - b : b - a;
}

function benchmarkCityOptions(rows: BenchmarkRouteRow[]): string[] {
  return [...new Set(rows.flatMap((row) => [row.sourceCity, row.targetCity]))].sort((a, b) => a.localeCompare(b));
}

function benchmarkCity(gate: Gate): string {
  return gate.city?.trim() || shortGateName(gate.name);
}

function benchmarkSummary(rows: BenchmarkRouteRow[], filteredRows: BenchmarkRouteRow[]): {
  publicSucceeded: number;
  doublezeroSucceeded: number;
  doublezeroNotApplicable: number;
  averageImprovementPercent: number | undefined;
} {
  const improvements = filteredRows
    .map((row) => row.rttImprovementPercent)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const averageImprovementPercent = improvements.length > 0
    ? compactMetric(improvements.reduce((sum, value) => sum + value, 0) / improvements.length)
    : undefined;
  return {
    publicSucceeded: filteredRows.filter((row) => row.route.public?.status === "succeeded").length,
    doublezeroSucceeded: filteredRows.filter((row) => row.route.doublezero?.status === "succeeded").length,
    doublezeroNotApplicable: filteredRows.filter((row) => row.route.doublezeroApplicability?.status === "not_applicable").length,
    averageImprovementPercent
  };
}

function benchmarkDoublezeroValueCell(route: BenchmarkRoute, value: string): string {
  const applicability = route.doublezeroApplicability;
  if (applicability?.status === "not_applicable") {
    const title = `DoubleZero benchmark is not applicable within the same DoubleZero metro (${applicability.metro}).`;
    return `<span class="muted" title="${escapeHtml(title)}">N/A — same DZ metro</span>`;
  }
  return benchmarkValueCell(route.doublezero, value);
}

function benchmarkValueCell(metric: BenchmarkMetric | undefined, value: string): string {
  if (!metric) {
    return '<span class="muted">pending</span>';
  }
  if (metric.status === "failed") {
    const title = metric.errorMessage || metric.errorCode || "probe failed";
    return `<span class="benchmark-failed" title="${escapeHtml(title)}">failed</span>`;
  }
  return escapeHtml(value);
}

function benchmarkEdgeRttCell(gate: Gate, value: number | undefined): string {
  const status = gate.doubleZero;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    if (status?.edgeRttError) {
      return `<span class="status-error" title="${escapeHtml(status.edgeRttError)}">failed</span>`;
    }
    return '<span class="muted">n/a</span>';
  }
  const titleParts = [
    status?.currentDevice ? `Current device: ${status.currentDevice}` : "",
    status?.edgeRttTarget ? `Tunnel Dst: ${status.edgeRttTarget}` : "",
    status?.edgeRttInterface ? `Interface: ${status.edgeRttInterface}` : "",
    status?.edgeRttMeasuredAt ? `Measured: ${relativeTime(status.edgeRttMeasuredAt)}` : ""
  ].filter(Boolean);
  const title = titleParts.length ? ` title="${escapeHtml(titleParts.join(" / "))}"` : "";
  return `<span${title}>${escapeHtml(formatMetricMs(value))}</span>`;
}

function benchmarkLossCell(route: BenchmarkRoute, row: BenchmarkRouteRow): string {
  return `
    <div class="stacked-metric">
      <span>${benchmarkDoublezeroValueCell(route, `DZ Loss ${formatLossPercent(row.doublezeroLossPercent)}`)}</span>
      <span>${benchmarkValueCell(route.public, `Internet Loss ${formatLossPercent(row.publicLossPercent)}`)}</span>
    </div>
  `;
}

function benchmarkOneWayClockErrorCell(route: BenchmarkRoute, row: BenchmarkRouteRow): string {
  return `
    <div class="stacked-metric">
      <span>${benchmarkDoublezeroValueCell(route, `DZ ${formatClockErrorMetricMs(row.doublezeroOneWayClockErrorMs)}`)}</span>
      <span>${benchmarkValueCell(route.public, `Internet ${formatClockErrorMetricMs(row.publicOneWayClockErrorMs)}`)}</span>
    </div>
  `;
}

function benchmarkEdgeOneWayEstimateCell(gate: Gate, value: number | undefined, directionLabel: string): string {
  const status = gate.doubleZero;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    if (status?.edgeRttError) {
      return `<span class="status-error" title="${escapeHtml(status.edgeRttError)}">failed</span>`;
    }
    return '<span class="muted">n/a</span>';
  }
  const titleParts = [
    `${directionLabel} estimate: latest edge RTT / 2`,
    edgeOneWayEstimateTooltip(),
    status?.currentDevice ? `Current device: ${status.currentDevice}` : "",
    status?.edgeRttTarget ? `Tunnel Dst: ${status.edgeRttTarget}` : "",
    status?.edgeRttInterface ? `Interface: ${status.edgeRttInterface}` : "",
    status?.edgeRttMeasuredAt ? `Measured: ${relativeTime(status.edgeRttMeasuredAt)}` : ""
  ].filter(Boolean);
  const title = titleParts.join(" / ");
  return `<span class="estimated-metric" title="${escapeHtml(title)}">${escapeHtml(formatEstimatedMetricMs(value))}</span>`;
}

function benchmarkInfoIcon(title: string): string {
  return `<span class="info-symbol" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">&#9432;</span>`;
}

function edgeOneWayEstimateTooltip(): string {
  return "Estimated as half of the latest gate-to-DZ RTT. True one-way gate-to-DZ or DZ-to-gate latency cannot be directly measured from this probe because the DoubleZero edge endpoint does not provide synchronized one-way timestamps.";
}

function oneWayClockErrorTooltip(): string {
  return "Clock Error is a chrony-based uncertainty estimate for directed one-way latency: source gate clock uncertainty plus target gate clock uncertainty. Each gate estimate uses abs(last offset) + RMS offset + root delay / 2 + root dispersion from chronyc tracking. It is not RTT / 2 and is not used to calculate one-way latency.";
}

function benchmarkImprovementCell(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return '<span class="muted">n/a</span>';
  }
  return `<span class="benchmark-improvement ${benchmarkImprovementClass(value)}">${escapeHtml(formatSignedPercent(value))}</span>`;
}

function benchmarkImprovementClass(value: number): string {
  if (value > 0) {
    return "benchmark-improvement-good";
  }
  if (value >= -10) {
    return "benchmark-improvement-similar";
  }
  return "benchmark-improvement-internet";
}

function benchmarkLegend(): string {
  return `
    <div class="benchmark-legend" aria-label="Benchmark legend">
      <span>Legend:</span>
      <span><i class="legend-swatch benchmark-improvement-good"></i>DZ faster</span>
      <span><i class="legend-swatch benchmark-improvement-similar"></i>Similar (0 to -10%)</span>
      <span><i class="legend-swatch benchmark-improvement-internet"></i>Internet faster (&lt; -10%)</span>
      <span>N/A — same DoubleZero metro is public-only</span>
    </div>
  `;
}

function benchmarkFreshness(matrix: BenchmarkMatrix | null): string {
  if (!matrix) {
    return "waiting for matrix";
  }
  const values = benchmarkMeasuredAtValues(matrix);
  if (values.length === 0) {
    return "waiting for first samples";
  }
  const latest = values[values.length - 1] ?? "";
  const now = Date.now();
  const freshCount = values.filter((value) => {
    const timestamp = Date.parse(value);
    return !Number.isNaN(timestamp) && now - timestamp <= benchmarkFreshWindowMs;
  }).length;
  const totalCount = matrix.routes.reduce(
    (count, route) => count + 1 + (route.doublezeroApplicability?.status === "not_applicable" ? 0 : 1),
    0
  );
  return `Latest sample ${relativeTime(latest)} · ${freshCount}/${totalCount} transports fresh within 15m`;
}

function benchmarkMeasuredAtValues(matrix: BenchmarkMatrix): string[] {
  const values = matrix.routes.flatMap((route) => [
    route.public?.measuredAt,
    route.doublezero?.measuredAt
  ]).filter((value): value is string => Boolean(value));
  return values.sort();
}

function shortGateName(value: string): string {
  return value.replace(/^gate-/, "").replace(/\.testnet\.hyperspace\.zone$/, "");
}

function formatMetricMs(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${formatLatency(value)}ms` : "n/a";
}

function formatEstimatedMetricMs(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${formatFixedLatency(value, 2)}ms` : "n/a";
}

function formatJitterMetricMs(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${formatFixedLatency(value, 2)}ms` : "n/a";
}

function formatClockErrorMetricMs(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `±${formatFixedLatency(value, 2)}ms` : "n/a";
}

function formatLossPercent(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return value === 0 ? "0%" : `${formatFixedLatency(value, 1)}%`;
}

function formatSignedMetricMs(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatLatency(value)}ms`;
}

function formatSavedMetricMs(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  if (value === 0) {
    return "0ms";
  }
  const sign = value > 0 ? "-" : "+";
  return `${sign}${formatLatency(Math.abs(value))}ms`;
}

function formatSavedJitterMetricMs(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  if (value === 0) {
    return "0.00ms";
  }
  const sign = value > 0 ? "-" : "+";
  return `${sign}${formatFixedLatency(Math.abs(value), 2)}ms`;
}

function formatSignedPercent(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatLatency(value)}%`;
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function summaryP95MinusP50(summary: BenchmarkMetricSummary | undefined): number | undefined {
  const p50 = finiteNumber(summary?.p50);
  const p95 = finiteNumber(summary?.p95);
  return typeof p50 === "number" && typeof p95 === "number" ? compactMetric(Math.max(0, p95 - p50)) : undefined;
}

function oneWayClockErrorMs(metric: BenchmarkMetric | undefined): number | undefined {
  return finiteNumber(metric?.oneWayDiagnostics?.clockErrorMs);
}

function maxOptionalMetric(...values: Array<number | undefined>): number | undefined {
  const finiteValues = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return finiteValues.length > 0 ? Math.max(...finiteValues) : undefined;
}

function estimatedOneWayFromRtt(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? compactMetric(value / 2) : undefined;
}

function compactMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "recently";
  }
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  return `${Math.round(minutes / 60)}h ago`;
}

function createSessionPanel(gates: Gate[]): string {
  const schedulableGates = gates.filter((gate) => gate.ready && gate.schedulable);
  const policyGates = schedulableGates.filter((gate) => !gateExcludedByDraftPolicy(gate));
  const ingressGates = sortIngressGates(policyGates);
  ensureSessionDraftGateSelection(ingressGates, policyGates);
  const emptyIngressLabel = gateCatalogLoadError
    ? "Unable to load ingress gates"
    : schedulableGates.length > 0
      ? "No ingress gates match routing policy"
      : "No ingress gates available";
  const ingressOptions = ingressGates.length === 0
    ? `<option value="" disabled selected>${emptyIngressLabel}</option>`
    : ingressGates
    .map((gate) => `<option value="${escapeHtml(gate.name)}" ${sessionDraft.ingressGateName === gate.name ? "selected" : ""}>${escapeHtml(gateOptionLabel(gate, true))}</option>`)
    .join("");
  const egressCandidates = policyGates.filter((gate) =>
    gate.name !== sessionDraft.ingressGateName &&
    (!sessionDraft.preferredRegion || gateRegion(gate) === sessionDraft.preferredRegion)
  );
  if (!egressCandidates.some((gate) => gate.name === sessionDraft.egressGateName)) {
    sessionDraft.egressGateName = "";
  }
  const egressOptions = egressCandidates.length === 0
    ? '<option value="" disabled selected>No distinct egress gate available</option>'
    : [
      `<option value="" disabled ${sessionDraft.egressGateName ? "" : "selected"}>Select egress gate</option>`,
      ...egressCandidates.map((gate) => `<option value="${escapeHtml(gate.name)}" ${sessionDraft.egressGateName === gate.name ? "selected" : ""}>${escapeHtml(gateOptionLabel(gate, false))}</option>`)
    ].join("");
  syncSessionDraftMode();
  const targetChecked = sessionDraft.restrictTarget;
  const modeLabel = draftRouteTypeLabel();
  const countries = uniqueSorted(schedulableGates.map((gate) => gate.country).filter((value): value is string => Boolean(value)));
  const cities = uniqueSorted(schedulableGates.map((gate) => gate.city).filter((value): value is string => Boolean(value)));
  return `
    <div class="configure-step">
      <p class="step-caption">Create VPN config - Step 1: Choose where traffic exits</p>
      <form id="session-form" class="session-form simplified-session-form" novalidate>
        <fieldset class="quick-config-choice">
          <label>Choose egress
            <select name="egressGateName" required ${sessionValidationErrors.egressGateName ? 'aria-invalid="true"' : ""}>
              ${egressOptions}
            </select>
            ${fieldError("egressGateName")}
            <small>Ingress is selected automatically from the nearest ready gate.</small>
          </label>
        </fieldset>

        <details id="optional-config-settings" class="optional-config-settings" ${createConfigOptionsOpen ? "open" : ""}>
          <summary>Optional settings</summary>
          <div class="optional-config-grid">
            <label>Config name <input name="label" placeholder="workstation to service" value="${escapeHtml(sessionDraft.label)}" /></label>
            <label>Ingress
              <select name="ingressGateName" required ${sessionValidationErrors.ingressGateName ? 'aria-invalid="true"' : ""}>
                ${ingressOptions}
              </select>
              ${fieldError("ingressGateName")}
              <small>Candidates are sorted by browser RTT when probes are available.</small>
            </label>
            <div class="mode-summary">
              <span>Mode</span>
              <strong id="mode-label">${escapeHtml(modeLabel)}</strong>
            </div>
            <fieldset class="form-group">
              <label class="checkbox-line">
                <input name="restrictSource" type="checkbox" ${sessionDraft.restrictSource ? "checked" : ""} />
                <span>Restrict ingress to source IP</span>
              </label>
              <div class="input-action-row">
                <input name="sourceIp" placeholder="8.8.8.8" value="${escapeHtml(sessionDraft.sourceIp)}" ${sessionDraft.restrictSource ? "" : "disabled"} ${sessionValidationErrors.sourceIp ? 'aria-invalid="true"' : ""} />
                <button id="use-browser-source-ip" type="button" ${sessionDraft.restrictSource ? "" : "disabled"}>Use browser IP</button>
              </div>
              ${fieldError("sourceIp")}
              <small>${browserIp ? `Current browser IP: ${escapeHtml(browserIp)}` : "Source restriction is optional."}</small>
            </fieldset>
            <fieldset class="form-group destination-restriction-group">
              <label class="checkbox-line">
                <input name="restrictTarget" type="checkbox" ${targetChecked ? "checked" : ""} />
                <span>Restrict outgoing traffic to one destination IP</span>
              </label>
              <input name="targetIp" placeholder="1.1.1.1" value="${escapeHtml(sessionDraft.targetIp)}" ${targetChecked ? "" : "disabled"} ${sessionValidationErrors.targetIp ? 'aria-invalid="true"' : ""} />
              <small id="target-mode-help">${escapeHtml(targetModeHelpText(targetChecked, sessionDraft.restrictSource))}</small>
              ${fieldError("targetIp")}
            </fieldset>
            <fieldset class="form-group client-key-group">
              <label class="checkbox-line">
                <input name="useClientPublicKey" type="checkbox" ${sessionDraft.useClientPublicKey ? "checked" : ""} />
                <span>Use my own WireGuard client public key</span>
              </label>
              ${sessionDraft.useClientPublicKey ? `
                <label>Client public key
                  <input name="clientPublicKey" placeholder="WireGuard public key" value="${escapeHtml(sessionDraft.clientPublicKey)}" required ${sessionValidationErrors.clientPublicKey ? 'aria-invalid="true"' : ""} />
                </label>
                <small>Paste the 44-character WireGuard public key only. Keep the private key on the client machine.</small>
                ${fieldError("clientPublicKey")}
                ${clientKeyInstructionsPanel()}
              ` : "<small>The control plane will generate a client key pair when this is off.</small>"}
            </fieldset>
            <fieldset class="form-group route-policy-group">
              <legend>Routing policy</legend>
              <label>Egress region
                <select name="preferredRegion">
                  ${regionOption("", "Any region")}
                  ${regionOption("eu", "Europe")}
                  ${regionOption("na", "North America")}
                  ${regionOption("ap", "Asia Pacific")}
                  ${regionOption("sa", "South America")}
                </select>
              </label>
              <details id="excluded-countries-settings" ${excludedCountriesOpen ? "open" : ""}>
                <summary>Excluded countries</summary>
                <div class="policy-option-grid">
                  ${countries.map((country) => policyCheckbox("excludeCountry", country, sessionDraft.excludeCountries)).join("")}
                </div>
              </details>
              <details id="excluded-cities-settings" ${excludedCitiesOpen ? "open" : ""}>
                <summary>Excluded cities</summary>
                <div class="policy-option-grid">
                  ${cities.map((city) => policyCheckbox("excludeCity", city, sessionDraft.excludeCities)).join("")}
                </div>
              </details>
              ${hasDraftRoutingPolicy() ? '<button id="reset-route-policy" class="secondary-button" type="button">Clear routing policy</button>' : ""}
            </fieldset>
          </div>
        </details>
        <button type="submit">Review config</button>
      </form>
    </div>
  `;
}

function createConfigConfirmationPanel(gates: Gate[]): string {
  const sourceLabel = sessionDraft.restrictSource ? sessionDraft.sourceIp.trim() : "Any source IP";
  const destinationLabel = sessionDraft.mode === "FullTunnel" ? "Internet" : `${sessionDraft.targetIp.trim()}/32`;
  const ingress = gateSummary(sessionDraft.ingressGateName, gates);
  const egress = gateSummary(sessionDraft.egressGateName, gates);
  const modeLabel = draftRouteTypeLabel();
  const clientKeyLabel = sessionDraft.useClientPublicKey ? "Provided by client" : "Generated by control plane";
  const routePolicyLabel = routePolicySummary();
  const policyText = sessionDraft.mode === "FullTunnel"
    ? `${sourceLabel} enters through the selected ingress, crosses DoubleZero, and exits to the Internet through the selected egress.`
    : `${sourceLabel} can reach only ${destinationLabel} through the selected ingress, DoubleZero transit, and selected egress.`;
  const paymentAmount = configPriceText();
  const buttonLabel = createConfigSubmitting ? `Paying ${paymentAmount}...` : `Pay ${paymentAmount} and create`;
  const disabled = createConfigSubmitting ? "disabled" : "";
  return `
    <div class="review-step">
      <p class="step-caption">Create VPN config - Step 2: Review and confirm</p>

      <div class="review-card">
        <h3>Route overview</h3>
        <div class="route-overview">
          ${summaryPill("Client", sourceLabel, sessionDraft.restrictSource)}
          <span class="route-arrow">&rarr;</span>
          ${summaryPill("Ingress", ingress.value, false, ingress.subvalue)}
          <span class="route-arrow">&rarr;</span>
          ${summaryPill("Transit", "DoubleZero")}
          <span class="route-arrow">&rarr;</span>
          ${summaryPill("Egress", egress.value, false, egress.subvalue)}
          <span class="route-arrow">&rarr;</span>
          ${summaryPill("Destination", destinationLabel, sessionDraft.mode === "IpToIp")}
        </div>

        <div class="review-grid">
          <div class="review-row review-row-primary">
            ${reviewField("Config name", sessionDraft.label.trim() || "Untitled config")}
            ${reviewField("Mode", modeLabel)}
          </div>
          <div class="review-row review-row-secondary">
            ${reviewField("Allowed source", sourceLabel, sessionDraft.restrictSource)}
            ${reviewField("Destination", destinationLabel, sessionDraft.mode === "IpToIp")}
            ${reviewField("Client public key", clientKeyLabel)}
            ${reviewField("Route policy", routePolicyLabel, routePolicyLabel !== "Default")}
          </div>
        </div>
      </div>

      <div class="policy-panel">
        <h3>Tunnel policy</h3>
        <p>${escapeHtml(policyText)}</p>
      </div>

      ${sessionDraft.mode === "FullTunnel" ? fullTunnelAlertPanel() : ""}
      ${sessionDraft.useClientPublicKey ? clientKeyReplacementNotice() : ""}

      <div class="config-payment-panel">
        <div>
          <small>One-time config price</small>
          <strong>${escapeHtml(paymentAmount)}</strong>
        </div>
        <p>The payment is sent from your Hyperspace Solana wallet when you confirm. A Solana network fee is added.</p>
      </div>
      ${createConfigPaymentError ? `
        <div class="config-payment-error" role="alert">
          <strong>Payment could not be completed</strong>
          <p>${escapeHtml(createConfigPaymentError)}</p>
          <a class="button-link" href="/billing" data-view="billing">Open Billing</a>
        </div>
      ` : ""}

      <div class="form-actions">
        <button id="edit-config" class="secondary-button" type="button" ${disabled}>Back to edit</button>
        <button id="confirm-create-config" class="success-button" type="button" ${disabled}>${buttonLabel}</button>
      </div>
    </div>
  `;
}

function createConfigResultPanel(): string {
  if (createdConfigError) {
    return `
      <div class="config-result-state">
        <p class="step-caption">Create VPN config - Could not finish</p>
        <div class="config-result-message config-result-error" role="alert">
          <strong>VPN config is not ready</strong>
          <p>${escapeHtml(createdConfigError)}</p>
        </div>
        <button id="return-to-config-settings" class="secondary-button" type="button">Back to settings</button>
      </div>
    `;
  }
  if (!createdConfigQrSvg) {
    return `
      <div class="config-result-state" aria-live="polite">
        <p class="step-caption">Create VPN config - Preparing connection</p>
        <div class="config-provisioning">
          <span class="loading-spinner" aria-hidden="true"></span>
          <div>
            <strong>Preparing WireGuard config</strong>
            <p>${escapeHtml(createdConfigPhaseText(createdConfigSessionPhase))}</p>
          </div>
        </div>
      </div>
    `;
  }
  return `
    <div class="config-result-state">
      <p class="step-caption">Create VPN config - Ready</p>
      <div class="created-config-result">
        <div class="created-config-qr" role="img" aria-label="WireGuard configuration QR code">${createdConfigQrSvg}</div>
        <div class="created-config-actions">
          <h3>WireGuard config is ready</h3>
          <p>Scan the QR code with the WireGuard mobile app or download the config file.</p>
          <button id="download-created-config" type="button">Download config</button>
          <button id="finish-create-config" class="success-button" type="button">OK</button>
        </div>
      </div>
    </div>
  `;
}

function createdConfigPhaseText(phase: string): string {
  const labels: Record<string, string> = {
    requested: "Request accepted. Waiting for gate assignment.",
    scheduling: "Selecting the gate path.",
    provisioning: "Applying the route and generating client artifacts.",
    finalizing: "Route is active. Finalizing the QR code and download."
  };
  return labels[phase] ?? "Waiting for the config and QR code to become ready.";
}

function regionOption(value: string, label: string): string {
  return `<option value="${escapeHtml(value)}" ${sessionDraft.preferredRegion === value ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function policyCheckbox(name: string, value: string, selected: string[]): string {
  return `
    <label class="checkbox-line compact-checkbox">
      <input name="${name}" type="checkbox" value="${escapeHtml(value)}" ${selected.includes(value) ? "checked" : ""} />
      <span>${escapeHtml(value)}</span>
    </label>
  `;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function gateExcludedByDraftPolicy(gate: Gate): boolean {
  return Boolean(
    (gate.country && sessionDraft.excludeCountries.includes(gate.country)) ||
    (gate.city && sessionDraft.excludeCities.includes(gate.city))
  );
}

function gateRegion(gate: Gate): string {
  return gate.name.split("-")[1]?.toLowerCase() ?? "";
}

function routePolicySummary(): string {
  const parts: string[] = [];
  if (sessionDraft.preferredRegion) {
    const labels: Record<string, string> = { eu: "Europe", na: "North America", ap: "Asia Pacific", sa: "South America" };
    parts.push(`Egress: ${labels[sessionDraft.preferredRegion] ?? sessionDraft.preferredRegion}`);
  }
  if (sessionDraft.excludeCountries.length > 0) {
    parts.push(`Avoid countries: ${sessionDraft.excludeCountries.join(", ")}`);
  }
  if (sessionDraft.excludeCities.length > 0) {
    parts.push(`Avoid cities: ${sessionDraft.excludeCities.join(", ")}`);
  }
  return parts.join("; ") || "Default";
}

function hasDraftRoutingPolicy(): boolean {
  return Boolean(
    sessionDraft.preferredRegion ||
    sessionDraft.excludeCountries.length > 0 ||
    sessionDraft.excludeCities.length > 0
  );
}

function resetSessionDraft(): void {
  sessionDraft.mode = "FullTunnel";
  sessionDraft.label = "";
  sessionDraft.restrictSource = false;
  sessionDraft.sourceIp = "";
  sessionDraft.restrictTarget = false;
  sessionDraft.targetIp = "";
  sessionDraft.ingressGateName = "";
  sessionDraft.egressGateName = "";
  sessionDraft.useClientPublicKey = false;
  sessionDraft.clientPublicKey = "";
  sessionDraft.excludeCountries = [];
  sessionDraft.excludeCities = [];
  sessionDraft.preferredRegion = "";
  ingressGateManuallySelected = false;
  createConfigOptionsOpen = false;
  excludedCountriesOpen = false;
  excludedCitiesOpen = false;
  createConfigPaymentRequestId = "";
  createConfigPaymentError = "";
  sessionValidationErrors = {};
}

function resetCreatedConfigResult(): void {
  createdConfigSessionId = "";
  createdConfigSessionPhase = "";
  createdConfigError = "";
  createdConfigQrSvg = "";
  createConfigSubmitting = false;
}

function clientKeyReplacementNotice(): string {
  const publicKey = sessionDraft.clientPublicKey.trim();
  return `
    <div class="client-key-notice" role="note">
      <strong>Private key replacement required</strong>
      <p>You provided your own WireGuard client public key. The downloaded config will contain a <span class="mono">PrivateKey</span> placeholder; replace it on the client with the private key that matches this public key.</p>
      <div class="notice-code-wrap">
        <button id="copy-client-public-key" class="copy-code-button notice-copy-button" type="button" aria-label="Copy client public key" title="Copy">
          <span class="copy-icon" aria-hidden="true"></span>
        </button>
        <code>${escapeHtml(publicKey)}</code>
      </div>
    </div>
  `;
}

function fullTunnelAlertPanel(): string {
  return `
    <div class="full-tunnel-alert" role="alert">
      <strong>Full tunnel can interrupt remote access</strong>
      <p>If you enable this config on a remote machine that you access over SSH or RDP, the current session can disconnect because traffic may move into the VPN. Apply it from a local console or keep out-of-band access available.</p>
    </div>
  `;
}

function summaryPill(label: string, value: string, mono = false, subvalue?: string): string {
  return `
    <div class="summary-pill">
      <span>${escapeHtml(label)}</span>
      <strong class="${mono ? "mono" : ""}">${escapeHtml(value)}</strong>
      ${subvalue ? `<small>${escapeHtml(subvalue)}</small>` : ""}
    </div>
  `;
}

function reviewField(label: string, value: string, mono = false): string {
  return `
    <div class="review-field">
      <span>${escapeHtml(label)}</span>
      <strong class="${mono ? "mono" : ""}">${escapeHtml(value)}</strong>
    </div>
  `;
}

function fieldError(field: keyof SessionValidationErrors): string {
  const message = sessionValidationErrors[field];
  return message ? `<p class="field-error">${escapeHtml(message)}</p>` : "";
}

function clientKeyInstructionsPanel(): string {
  const script = keyInstructionScript(keyInstructionPlatform);
  return `
    <section class="key-instructions" aria-label="Client public key generation">
      <div class="key-instructions-header">
        <div>
          <h3>Generate a client public key</h3>
          <p>Run this on the client machine. Paste only the public key into the field above.</p>
        </div>
      </div>
      <div class="key-instruction-tabs" role="tablist" aria-label="Operating system">
        ${keyInstructionTab("linux", "Linux (Ubuntu/Debian)")}
        ${keyInstructionTab("macos", "macOS")}
        ${keyInstructionTab("windows", "Windows (PowerShell)")}
      </div>
      <div class="key-script-wrap">
        <button id="copy-key-script" class="copy-code-button" type="button" aria-label="Copy key generation script" title="Copy">
          <span class="copy-icon" aria-hidden="true"></span>
        </button>
        <pre class="key-script"><code>${highlightKeyScript(script, keyInstructionPlatform)}</code></pre>
      </div>
      <p class="key-docs">Official docs: <a href="https://www.wireguard.com/install/" target="_blank" rel="noreferrer">installation</a>, <a href="https://www.wireguard.com/quickstart/" target="_blank" rel="noreferrer">key generation</a>.</p>
    </section>
  `;
}

function keyInstructionTab(platform: KeyInstructionPlatform, label: string): string {
  const active = keyInstructionPlatform === platform;
  return `
    <button class="key-instruction-tab ${active ? "active" : ""}" type="button" role="tab" aria-selected="${active ? "true" : "false"}" data-key-instruction-tab="${platform}">
      ${escapeHtml(label)}
    </button>
  `;
}

function keyInstructionScript(platform: KeyInstructionPlatform): string {
  if (platform === "macos") {
    return [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "",
      "if ! command -v wg >/dev/null 2>&1; then",
      "  if ! command -v brew >/dev/null 2>&1; then",
      "    echo \"Homebrew is required to install wireguard-tools.\"",
      "    echo \"Install Homebrew from https://brew.sh/ and run this script again.\"",
      "    exit 1",
      "  fi",
      "  brew install wireguard-tools",
      "else",
      "  echo \"WireGuard tools are already installed: $(command -v wg)\"",
      "fi",
      "",
      "mkdir -p \"$HOME/hyperspace-wg-keys\"",
      "cd \"$HOME/hyperspace-wg-keys\"",
      "",
      "( umask 077 && wg genkey | tee client-private.key | wg pubkey > client-public.key )",
      "",
      "printf \"\\nClient public key:\\n\"",
      "cat client-public.key"
    ].join("\n");
  }
  if (platform === "windows") {
    return [
      "$ErrorActionPreference = \"Stop\"",
      "",
      "function Get-WgPath {",
      "  $cmd = Get-Command wg -ErrorAction SilentlyContinue",
      "  if ($cmd) { return $cmd.Source }",
      "",
      "  $paths = @(",
      "    \"$env:ProgramFiles\\WireGuard\\wg.exe\",",
      "    \"${env:ProgramFiles(x86)}\\WireGuard\\wg.exe\"",
      "  )",
      "",
      "  foreach ($path in $paths) {",
      "    if ($path -and (Test-Path $path)) { return $path }",
      "  }",
      "",
      "  return $null",
      "}",
      "",
      "$wg = Get-WgPath",
      "if (-not $wg) {",
      "  if (Get-Command winget -ErrorAction SilentlyContinue) {",
      "    winget install -e --id WireGuard.WireGuard",
      "    $wg = Get-WgPath",
      "  }",
      "",
      "  if (-not $wg) {",
      "    throw \"Install WireGuard from https://www.wireguard.com/install/ and run this script again.\"",
      "  }",
      "} else {",
      "  Write-Host \"WireGuard is already installed: $wg\"",
      "}",
      "",
      "$keyDir = Join-Path $HOME \"hyperspace-wg-keys\"",
      "New-Item -ItemType Directory -Force -Path $keyDir | Out-Null",
      "",
      "$privateKeyPath = Join-Path $keyDir \"client-private.key\"",
      "$publicKeyPath = Join-Path $keyDir \"client-public.key\"",
      "",
      "$privateKey = & $wg genkey",
      "Set-Content -Path $privateKeyPath -Value $privateKey -NoNewline",
      "$publicKey = $privateKey | & $wg pubkey",
      "Set-Content -Path $publicKeyPath -Value $publicKey -NoNewline",
      "",
      "Write-Host \"\"",
      "Write-Host \"Client public key:\"",
      "Get-Content $publicKeyPath"
    ].join("\n");
  }
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "if ! command -v wg >/dev/null 2>&1; then",
    "  if command -v sudo >/dev/null 2>&1; then",
    "    sudo apt update",
    "    sudo apt install -y wireguard-tools",
      "  else",
      "    apt update",
      "    apt install -y wireguard-tools",
      "  fi",
      "else",
      "  echo \"WireGuard tools are already installed: $(command -v wg)\"",
      "fi",
    "",
    "mkdir -p \"$HOME/hyperspace-wg-keys\"",
    "cd \"$HOME/hyperspace-wg-keys\"",
    "",
    "( umask 077 && wg genkey | tee client-private.key | wg pubkey > client-public.key )",
    "",
    "printf \"\\nClient public key:\\n\"",
    "cat client-public.key"
  ].join("\n");
}

function highlightKeyScript(script: string, platform: KeyInstructionPlatform): string {
  return script
    .split("\n")
    .map((line) => `<span class="code-line">${highlightKeyScriptLine(line, platform)}</span>`)
    .join("\n");
}

function highlightKeyScriptLine(line: string, platform: KeyInstructionPlatform): string {
  const escaped = escapeHtml(line);
  if (/^\s*#/.test(line)) {
    return `<span class="syntax-comment">${escaped}</span>`;
  }
  const commandPattern = platform === "windows"
    ? /^(\s*)([A-Za-z][A-Za-z0-9_-]*)/
    : /^(\s*)([A-Za-z][A-Za-z0-9_-]*)/;
  return escaped
    .replace(commandPattern, (_match, indent: string, command: string) => `${indent}<span class="syntax-command">${command}</span>`)
    .replace(/(&quot;[^&]*(?:&amp;[^&]*)*&quot;)/g, '<span class="syntax-string">$1</span>')
    .replace(/(\$\{?[A-Za-z_][A-Za-z0-9_:(){}]*\}?)/g, '<span class="syntax-variable">$1</span>')
    .replace(/(\||&amp;&amp;|&gt;)/g, '<span class="syntax-operator">$1</span>');
}

function gateSummary(gateName: string, gates: Gate[]): { value: string; subvalue?: string } {
  if (!gateName) {
    return { value: "Not selected" };
  }
  const gate = gates.find((entry) => entry.name === gateName) ?? latestGates.find((entry) => entry.name === gateName);
  if (!gate) {
    return { value: gateName };
  }
  return {
    value: gate.name,
    subvalue: `${gateLocationLabel(gate)}, ${gate.publicIpv4}`
  };
}

function vpnConfigsPanel(sessions: Session[]): string {
  if (sessions.length === 0) {
    return `
      <div class="empty-state">
        <p>No VPN configs yet.</p>
        <a class="button-link" href="/create-config" data-view="create-config">Create config</a>
      </div>
    `;
  }
  return `
    <div class="table-scroll">
      <table class="vpn-configs-table">
        <thead><tr><th class="created-column">Created</th><th class="mode-column">Mode</th><th>Config</th><th class="source-column">Source IP</th><th class="target-column">Target IP</th><th class="ingress-column">Ingress gate</th><th class="egress-column">Egress gate</th><th>Status</th><th class="actions-column">Actions</th></tr></thead>
        <tbody>
          ${sessions
            .map(
		              (session) => `
		                <tr>
		                  <td class="created-column">${createdAtCell(session.createdAt)}</td>
	                  <td class="mode-column"><strong>${escapeHtml(sessionRouteTypeLabel(session))}</strong></td>
		                  <td>${configCell(session)}</td>
		                  <td class="source-column">${sourceIpCell(session)}</td>
			                  <td class="target-column">${targetIpCell(session)}</td>
			                  <td class="ingress-column">${gateNameCell(session.selectedPath?.ingressGateName)}</td>
			                  <td class="egress-column">${gateNameCell(session.selectedPath?.egressGateName)}</td>
			                  <td class="status-column">${sessionStatusCell(session)}</td>
			                  <td class="actions-column"><div class="action-buttons">${vpnConfigActions(session)}</div></td>
		                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
    ${activeConfigQrSvg ? `
      <div class="qr-overlay" role="dialog" aria-modal="true" aria-label="WireGuard configuration QR code">
        <div class="qr-dialog">
          <div class="panel-heading">
            <h3>Scan with WireGuard</h3>
            <button id="close-config-qr" class="secondary-button" type="button">Close</button>
          </div>
          <div class="config-qr">${activeConfigQrSvg}</div>
          <small>Session ${escapeHtml(activeConfigQrSessionId.slice(0, 8))}. Treat this QR code as a private key.</small>
        </div>
      </div>
    ` : ""}
  `;
}

function vpnConfigActions(session: Session): string {
  const isRevoking = revokingConfigIds.has(session.id) || session.phase === "revoking";
  const isDeleting = deletingConfigIds.has(session.id);
  const isActive = session.phase === "active";
  const isRevoked = session.phase === "revoked";
  const downloadDisabled = !isActive || isRevoking || isDeleting || isRevoked ? "disabled" : "";
  const revokeDisabled = !isActive || isRevoking || isDeleting || isRevoked ? "disabled" : "";
  const deleteDisabled = isDeleting ? "disabled" : "";
  const revokeLabel = isDeleting ? "Revoking..." : isRevoked ? "Revoked" : isRevoking ? "Revoking..." : "Revoke";
  const deleteLabel = isDeleting ? "Deleting..." : "Delete";
  return `
    <button data-download="${escapeHtml(session.id)}" ${downloadDisabled}>Download</button>
    <button data-qr="${escapeHtml(session.id)}" ${downloadDisabled}>QR</button>
    <button data-connect-helper="${escapeHtml(session.id)}" ${downloadDisabled}>Connect</button>
    <button data-revoke="${escapeHtml(session.id)}" ${revokeDisabled}>${revokeLabel}</button>
    <button class="danger-button" data-delete="${escapeHtml(session.id)}" ${deleteDisabled}>${deleteLabel}</button>
  `;
}

function sessionStatusCell(session: Session): string {
  const label = phaseLabel(session.phase);
  if (session.phase === "failed") {
    const message = session.lastError?.message || session.lastError?.code || "Provisioning failed";
    return `
      <div class="status-cell status-error">
        <strong>${escapeHtml(label)}</strong>
        <small>${escapeHtml(shortStatusMessage(message))}</small>
      </div>
    `;
  }
  if (session.phase === "provisioning") {
    return `
      <div class="status-cell">
        <strong>${escapeHtml(label)}</strong>
        <small>waiting for gate confirmation</small>
      </div>
    `;
  }
  return `<span class="status-cell"><strong>${escapeHtml(label)}</strong></span>`;
}

function phaseLabel(phase: string): string {
  return phase
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function shortStatusMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length <= 96) {
    return trimmed;
  }
  return `${trimmed.slice(0, 93)}...`;
}

function configCell(session: Session): string {
  const shortId = session.id.slice(0, 8);
  const label = session.label?.trim();
  if (!label) {
    return `<strong class="mono">${escapeHtml(shortId)}</strong>`;
  }
  return `
    <strong>${escapeHtml(label)}</strong>
    <small class="mono">${escapeHtml(shortId)}</small>
  `;
}

function bindHandlers(): void {
  document.getElementById("logout")?.addEventListener("click", () => {
    token = "";
    currentView = "login";
    createConfigStep = "configure";
    resetCreatedConfigResult();
    resetSessionDraft();
    latestMe = null;
    latestSessions = [];
    latestAdminBilling = null;
    latestAdminTraffic = null;
    gateLatencyInProgressIds.clear();
    gateLatencyMeasurementInFlight = false;
    automaticGateLatencyMeasurementStarted = false;
    stopSessionAutoRefresh();
    localStorage.removeItem("hyperspaceAccessToken");
    window.history.replaceState({}, "", viewPath("login"));
    render({ gates: decorateGates(latestGates), sessions: [], me: null, benchmarkMatrix: latestBenchmarkMatrix });
  });

  for (const target of document.querySelectorAll("[data-view]")) {
    target.addEventListener("click", (event) => {
      const view = (target as HTMLElement).dataset.view;
      if (isAppView(view)) {
        event.preventDefault();
        navigateToView(view);
      }
    });
  }

  document.getElementById("register-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    void registerWithPassword(form);
  });

  document.getElementById("login-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    void submitPasswordLogin(form);
  });

  document.getElementById("email-code-request-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    void requestEmailCode(form);
  });

  document.getElementById("email-code-verify-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    void verifyEmailCode(form);
  });

  document.getElementById("google-login")?.addEventListener("click", () => {
    void startGoogleLogin();
  });

  document.getElementById("session-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    updateSessionDraftFromForm(event.target as HTMLFormElement);
    sessionValidationErrors = validateSessionDraft();
    const validationError = firstSessionValidationError(sessionValidationErrors);
    if (validationError) {
      render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
      log(validationError);
      return;
    }
    sessionValidationErrors = {};
    createConfigStep = "confirm";
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  const sessionForm = document.getElementById("session-form") as HTMLFormElement | null;
  if (sessionForm) {
    sessionForm.addEventListener("input", () => {
      clearSessionValidationErrors();
      updateSessionDraftFromForm(sessionForm);
      syncSessionFormControls(sessionForm);
      updateSessionDraftFromForm(sessionForm);
    });
    sessionForm.addEventListener("change", (event) => {
      const fieldName = (event.target as HTMLInputElement | HTMLSelectElement | null)?.name;
      if (fieldName === "ingressGateName") {
        ingressGateManuallySelected = true;
      }
      clearSessionValidationErrors();
      updateSessionDraftFromForm(sessionForm);
      if (["ingressGateName", "preferredRegion", "excludeCountry", "excludeCity"].includes(fieldName ?? "")) {
        render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
        return;
      }
      if (fieldName === "useClientPublicKey") {
        render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
        return;
      }
      syncSessionFormControls(sessionForm);
      updateSessionDraftFromForm(sessionForm);
    });
    syncSessionFormControls(sessionForm);
  }
  document.getElementById("optional-config-settings")?.addEventListener("toggle", (event) => {
    createConfigOptionsOpen = (event.currentTarget as HTMLDetailsElement).open;
  });
  document.getElementById("excluded-countries-settings")?.addEventListener("toggle", (event) => {
    excludedCountriesOpen = (event.currentTarget as HTMLDetailsElement).open;
  });
  document.getElementById("excluded-cities-settings")?.addEventListener("toggle", (event) => {
    excludedCitiesOpen = (event.currentTarget as HTMLDetailsElement).open;
  });

  document.getElementById("use-browser-source-ip")?.addEventListener("click", () => {
    void fillBrowserSourceIp();
  });
  for (const button of document.querySelectorAll("[data-key-instruction-tab]")) {
    button.addEventListener("click", () => {
      const platform = (button as HTMLElement).dataset.keyInstructionTab;
      if (!isKeyInstructionPlatform(platform)) {
        return;
      }
      const form = document.getElementById("session-form") as HTMLFormElement | null;
      if (form) {
        updateSessionDraftFromForm(form);
      }
      keyInstructionPlatform = platform;
      render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    });
  }
  document.getElementById("copy-key-script")?.addEventListener("click", (event) => {
    void copyKeyInstructionScript(event.currentTarget as HTMLButtonElement);
  });
  document.getElementById("copy-client-public-key")?.addEventListener("click", (event) => {
    void copyClientPublicKey(event.currentTarget as HTMLButtonElement);
  });
  document.getElementById("edit-config")?.addEventListener("click", () => {
    createConfigPaymentRequestId = "";
    createConfigPaymentError = "";
    createConfigStep = "configure";
    sessionValidationErrors = {};
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  document.getElementById("confirm-create-config")?.addEventListener("click", () => {
    void createSession();
  });
  document.getElementById("return-to-config-settings")?.addEventListener("click", () => {
    resetCreatedConfigResult();
    createConfigStep = "configure";
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  });
  document.getElementById("download-created-config")?.addEventListener("click", () => {
    if (createdConfigSessionId) void downloadArtifact(createdConfigSessionId);
  });
  document.getElementById("finish-create-config")?.addEventListener("click", () => {
    resetSessionDraft();
    resetCreatedConfigResult();
    navigateToView("dashboard");
    void refresh({ skipAutoMeasure: true });
  });
  document.getElementById("reset-route-policy")?.addEventListener("click", () => {
    sessionDraft.excludeCountries = [];
    sessionDraft.excludeCities = [];
    sessionDraft.preferredRegion = "";
    sessionValidationErrors = {};
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  });
  document.getElementById("withdrawal-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void requestWithdrawal(new FormData(event.target as HTMLFormElement));
  });
  document.getElementById("refresh-billing")?.addEventListener("click", () => {
    void refresh({ skipAutoMeasure: true });
  });
  for (const button of document.querySelectorAll("[data-cancel-withdrawal]")) {
    button.addEventListener("click", () => {
      const id = (button as HTMLElement).dataset.cancelWithdrawal;
      if (id) void cancelWithdrawal(id);
    });
  }
  document.getElementById("admin-config-filters")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    adminConfigSearch = String(form.get("search") ?? "").trim();
    adminConfigFilter = String(form.get("status") ?? "active");
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  });
  document.getElementById("admin-traffic-config")?.addEventListener("change", (event) => {
    adminTrafficSessionId = String((event.target as HTMLSelectElement).value ?? "");
    void refreshAdminTraffic();
  });
  for (const button of document.querySelectorAll("[data-admin-traffic-range]")) {
    button.addEventListener("click", () => {
      const range = (button as HTMLElement).dataset.adminTrafficRange;
      if (range === "24h" || range === "7d" || range === "30d") {
        adminTrafficRange = range;
        void refreshAdminTraffic();
      }
    });
  }
  document.getElementById("refresh-admin-traffic")?.addEventListener("click", () => {
    void refreshAdminTraffic();
  });
  for (const row of document.querySelectorAll("[data-admin-config-row]")) {
    row.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("a,button,input,select")) return;
      const sessionId = (row as HTMLElement).dataset.adminConfigRow;
      if (sessionId) {
        adminTrafficSessionId = sessionId;
        void refreshAdminTraffic();
      }
    });
  }
  for (const button of document.querySelectorAll("[data-copy-wallet]")) {
    button.addEventListener("click", () => {
      const value = (button as HTMLElement).dataset.copyWallet ?? "";
      void navigator.clipboard.writeText(value).then(() => log("Deposit address copied."));
    });
  }
  document.getElementById("measure-gates")?.addEventListener("click", () => {
    runGateLatencyMeasurement();
  });
  for (const button of document.querySelectorAll("[data-sort-gates]")) {
    button.addEventListener("click", () => {
      const field = (button as HTMLElement).dataset.sortGates;
      if (!isGateSortField(field)) {
        return;
      }
      if (gateSortField === field) {
        if (field === "clock-error") {
          gateClockErrorSortDirection = gateClockErrorSortDirection === "desc" ? "asc" : "desc";
        } else {
          gateBrowserRttSortDirection = gateBrowserRttSortDirection === "desc" ? "asc" : "desc";
        }
      } else {
        gateSortField = field;
      }
      render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    });
  }
  for (const button of document.querySelectorAll("[data-sort-benchmark-rtt]")) {
    button.addEventListener("click", () => {
      const field = (button as HTMLElement).dataset.sortBenchmarkRtt;
      if (!isBenchmarkRttSortField(field)) {
        return;
      }
      if (benchmarkRttSortField === field) {
        benchmarkRttSortDirection = benchmarkRttSortDirection === "desc" ? "asc" : "desc";
      } else {
        benchmarkRttSortField = field;
        benchmarkRttSortDirection = benchmarkRttDefaultSortDirection(field);
      }
      render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    });
  }
  for (const button of document.querySelectorAll("[data-sort-benchmark-one-way]")) {
    button.addEventListener("click", () => {
      const field = (button as HTMLElement).dataset.sortBenchmarkOneWay;
      if (!isBenchmarkOneWaySortField(field)) {
        return;
      }
      if (benchmarkOneWaySortField === field) {
        benchmarkOneWaySortDirection = benchmarkOneWaySortDirection === "desc" ? "asc" : "desc";
      } else {
        benchmarkOneWaySortField = field;
        benchmarkOneWaySortDirection = benchmarkOneWayDefaultSortDirection(field);
      }
      render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    });
  }
  document.getElementById("benchmark-city-filter")?.addEventListener("change", (event) => {
    benchmarkCityFilter = String((event.target as HTMLSelectElement).value ?? "");
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  });

  for (const button of document.querySelectorAll("[data-revoke]")) {
    button.addEventListener("click", () => {
      const id = (button as HTMLElement).dataset.revoke;
      if (id) void revokeSession(id);
    });
  }

  for (const button of document.querySelectorAll("[data-delete]")) {
    button.addEventListener("click", () => {
      const id = (button as HTMLElement).dataset.delete;
      if (id) void deleteVpnConfig(id);
    });
  }

  for (const button of document.querySelectorAll("[data-download]")) {
    button.addEventListener("click", () => {
      const id = (button as HTMLElement).dataset.download;
      if (id) void downloadArtifact(id);
    });
  }
  for (const button of document.querySelectorAll("[data-qr]")) {
    button.addEventListener("click", () => {
      const id = (button as HTMLElement).dataset.qr;
      if (id) void showConfigQr(id);
    });
  }
  for (const button of document.querySelectorAll("[data-connect-helper]")) {
    button.addEventListener("click", () => {
      const id = (button as HTMLElement).dataset.connectHelper;
      if (id) void downloadConnectHelper(id);
    });
  }
  document.getElementById("close-config-qr")?.addEventListener("click", () => {
    activeConfigQrSvg = "";
    activeConfigQrSessionId = "";
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  });
}

async function registerWithPassword(form: FormData): Promise<void> {
  const email = String(form.get("email") ?? "").trim();
  try {
    const response = await api("/v1/public/auth/register", {
      method: "POST",
      body: {
        email,
        password: String(form.get("password") ?? "")
      }
    });
    emailOtpPendingEmail = response.email || email;
    currentView = "login";
    window.history.replaceState({}, "", viewPath("login"));
    log(response.devCode ? `Account created. Test verification code: ${response.devCode}` : "Account created. Check your email to verify it.");
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  } catch (error) {
    if (error instanceof Error && error.message === "email_already_registered") {
      emailOtpPendingEmail = email;
      currentView = "login";
      window.history.replaceState({}, "", viewPath("login"));
      log("This email already has an account. Use Google, an email code, or your password to log in.");
      render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
      return;
    }
    log(error instanceof Error ? error.message : "Could not create account.");
  }
}

async function submitPasswordLogin(form: FormData): Promise<void> {
  const email = String(form.get("email") ?? "").trim();
  try {
    const response = await api("/v1/public/auth/login", {
      method: "POST",
      body: {
        email,
        password: String(form.get("password") ?? "")
      }
    });
    completeAuth(response);
    log("Signed in with password.");
    await refresh();
  } catch (error) {
    if (error instanceof Error && error.message === "email_not_verified") {
      emailOtpPendingEmail = email;
      await sendEmailCode(email);
      return;
    }
    log(error instanceof Error ? error.message : "Could not log in.");
  }
}

async function requestEmailCode(form: FormData): Promise<void> {
  if (emailOtpBusy) {
    return;
  }
  emailOtpBusy = true;
  emailOtpPendingEmail = String(form.get("email") ?? "").trim();
  render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  await sendEmailCode(emailOtpPendingEmail, true);
}

async function sendEmailCode(email: string, alreadyBusy = false): Promise<void> {
  if (!alreadyBusy) {
    emailOtpBusy = true;
    emailOtpPendingEmail = email;
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  }
  try {
    const response = await api("/v1/public/auth/email/request-code", {
      method: "POST",
      body: { email }
    });
    emailOtpPendingEmail = response.email || emailOtpPendingEmail;
    log(response.devCode ? `Email code sent. Test code: ${response.devCode}` : "Email code sent.");
  } catch (error) {
    log(error instanceof Error ? error.message : "Could not send email code.");
  } finally {
    emailOtpBusy = false;
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  }
}

async function verifyEmailCode(form: FormData): Promise<void> {
  if (emailOtpBusy) {
    return;
  }
  emailOtpBusy = true;
  render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  try {
    const response = await api("/v1/public/auth/email/verify-code", {
      method: "POST",
      body: {
        email: emailOtpPendingEmail,
        code: String(form.get("code") ?? "")
      }
    });
    completeAuth(response);
    emailOtpPendingEmail = "";
    log("Signed in with email code.");
    await refresh();
  } catch (error) {
    log(error instanceof Error ? error.message : "Could not verify email code.");
  } finally {
    emailOtpBusy = false;
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  }
}

async function startGoogleLogin(): Promise<void> {
  if (googleLoginBusy) {
    return;
  }
  googleLoginBusy = true;
  render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  try {
    const redirectAfter = `${window.location.pathname}${window.location.search}`;
    const response = await api(`/v1/public/auth/google/start?redirect=${encodeURIComponent(redirectAfter)}`, { method: "GET" });
    window.location.href = response.authorizationUrl;
  } catch (error) {
    googleLoginBusy = false;
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    log(error instanceof Error ? error.message : "Google login is not configured yet.");
  }
}

function completeAuth(response: { accessToken: string }): void {
  token = response.accessToken;
  currentView = "dashboard";
  createConfigStep = "configure";
  resetCreatedConfigResult();
  resetSessionDraft();
  localStorage.setItem("hyperspaceAccessToken", token);
  window.history.replaceState({}, "", viewPath("dashboard"));
}

async function createSession(): Promise<void> {
  if (createConfigSubmitting) {
    return;
  }
  sessionValidationErrors = validateSessionDraft();
  const validationError = firstSessionValidationError(sessionValidationErrors);
  if (validationError) {
    log(validationError);
    createConfigStep = "configure";
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    return;
  }
  createConfigSubmitting = true;
  createConfigPaymentError = "";
  createConfigPaymentRequestId ||= crypto.randomUUID();
  sessionValidationErrors = {};
  render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  try {
    const payload = { ...sessionPayloadFromDraft(), paymentRequestId: createConfigPaymentRequestId };
    let response: any = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await api("/v1/public/sessions", { method: "POST", body: payload });
        break;
      } catch (error) {
        const paymentStillFinalizing = error instanceof ApiRequestError
          && error.code === "config_payment_in_progress";
        if (!paymentStillFinalizing || attempt === 2) throw error;
        log("SOL payment submitted. Waiting for finalization.");
        await wait(1_000);
      }
    }
    const sessionId = typeof response.session?.id === "string" ? response.session.id : "";
    if (!sessionId) {
      throw new Error("The control plane did not return the created VPN config.");
    }
    createConfigSubmitting = false;
    createdConfigSessionId = sessionId;
    createdConfigSessionPhase = typeof response.session?.phase === "string" ? response.session.phase : "requested";
    createdConfigError = "";
    createdConfigQrSvg = "";
    createConfigStep = "result";
    log("VPN config requested.");
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    await waitForCreatedConfigArtifact(sessionId);
  } catch (error) {
    createConfigSubmitting = false;
    if (error instanceof ApiRequestError && error.code === "insufficient_solana_funds") {
      createConfigPaymentError = "Insufficient spendable SOL for 0.0001 SOL, the network fee, and the Solana account rent reserve. Top up your wallet on Billing, then retry Confirm.";
    } else if (error instanceof ApiRequestError && error.code.startsWith("config_payment_")) {
      createConfigPaymentError = error.message;
    }
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    log(error instanceof Error ? error.message : "Could not create VPN config.");
  }
}

async function waitForCreatedConfigArtifact(sessionId: string): Promise<void> {
  const attempts = 160;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (createdConfigSessionId !== sessionId) return;
    try {
      latestSessions = await getSessions();
      const session = latestSessions.find((entry) => entry.id === sessionId);
      if (session) {
        const phaseChanged = createdConfigSessionPhase !== session.phase;
        createdConfigSessionPhase = session.phase;
        if (session.phase === "failed" || session.phase === "revoked") {
          createdConfigError = session.lastError?.message || `VPN config entered ${session.phase} state.`;
          render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
          return;
        }
        if (session.phase === "active") {
          try {
            createdConfigQrSvg = await fetchConfigQrSvg(sessionId);
            render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
            return;
          } catch {
            createdConfigSessionPhase = "finalizing";
          }
        }
        if (phaseChanged || attempt === 0) {
          render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
        }
      }
    } catch {
      // Transient API failures are retried while this result page remains open.
    }
    await wait(1500);
  }
  if (createdConfigSessionId !== sessionId) return;
  createdConfigError = "Timed out while waiting for the WireGuard artifact. The request remains visible on Dashboard.";
  render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
}

async function requestWithdrawal(form: FormData): Promise<void> {
  if (withdrawalBusy) return;
  const amountMinor = Math.round(Number(String(form.get("amountUsd") ?? "0").replace(",", ".")) * 100);
  withdrawalBusy = true;
  render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  try {
    await api("/v1/public/billing/withdrawals", {
      method: "POST",
      body: { amountMinor, destinationAddress: String(form.get("destinationAddress") ?? "") }
    });
    log("Withdrawal cooldown started.");
    await refresh({ skipAutoMeasure: true });
  } catch (error) {
    log(error instanceof Error ? error.message : "Could not request withdrawal.");
  } finally {
    withdrawalBusy = false;
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  }
}

async function cancelWithdrawal(withdrawalId: string): Promise<void> {
  try {
    await api(`/v1/public/billing/withdrawals/${encodeURIComponent(withdrawalId)}`, { method: "DELETE" });
    log("Withdrawal cancelled.");
    await refresh({ skipAutoMeasure: true });
  } catch (error) {
    log(error instanceof Error ? error.message : "Could not cancel withdrawal.");
  }
}

async function refreshAdminTraffic(): Promise<void> {
  if (adminTrafficLoading) return;
  adminTrafficLoading = true;
  render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  try {
    latestAdminTraffic = await getAdminTraffic();
  } catch (error) {
    log(error instanceof Error ? error.message : "Could not load traffic counters.");
  } finally {
    adminTrafficLoading = false;
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  }
}

function validateSessionDraft(): SessionValidationErrors {
  const errors: SessionValidationErrors = {};
  const sourceIp = sessionDraft.sourceIp.trim();
  const targetIp = sessionDraft.targetIp.trim();
  if (sessionDraft.restrictSource && !isIpv4(sourceIp)) {
    errors.sourceIp = "Enter a valid IPv4 source address.";
  }
  if (sessionDraft.mode === "IpToIp" && !isIpv4(targetIp)) {
    errors.targetIp = "Enter a valid IPv4 target address, or clear the checkbox for Full tunnel.";
  }
  if (!sessionDraft.ingressGateName) {
    errors.ingressGateName = "Select an ingress gate.";
  }
  if (!sessionDraft.egressGateName) {
    errors.egressGateName = "Select an egress gate.";
  }
  if (sessionDraft.ingressGateName && sessionDraft.egressGateName && sessionDraft.ingressGateName === sessionDraft.egressGateName) {
    errors.egressGateName = "Select a different egress gate.";
  }
  if (sessionDraft.useClientPublicKey && !sessionDraft.clientPublicKey.trim()) {
    errors.clientPublicKey = "Enter a WireGuard client public key.";
  } else if (sessionDraft.useClientPublicKey && !isWireGuardPublicKey(sessionDraft.clientPublicKey)) {
    errors.clientPublicKey = "Enter a canonical 44-character WireGuard public key.";
  }
  return errors;
}

function firstSessionValidationError(errors: SessionValidationErrors): string | null {
  return errors.sourceIp ?? errors.targetIp ?? errors.ingressGateName ?? errors.egressGateName ?? errors.clientPublicKey ?? null;
}

function clearSessionValidationErrors(): void {
  if (Object.keys(sessionValidationErrors).length === 0) {
    return;
  }
  sessionValidationErrors = {};
  for (const errorNode of document.querySelectorAll(".field-error")) {
    errorNode.remove();
  }
  for (const invalidNode of document.querySelectorAll("[aria-invalid='true']")) {
    invalidNode.removeAttribute("aria-invalid");
  }
}

function sessionPayloadFromDraft(): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    mode: sessionDraft.mode,
    label: optionalDraftString(sessionDraft.label),
    sourceIp: sessionDraft.restrictSource ? optionalDraftString(sessionDraft.sourceIp) : undefined,
    ingressGateName: optionalDraftString(sessionDraft.ingressGateName),
    egressGateName: optionalDraftString(sessionDraft.egressGateName),
    clientPublicKey: sessionDraft.useClientPublicKey ? optionalDraftString(sessionDraft.clientPublicKey) : undefined
  };
  if (sessionDraft.mode === "IpToIp") {
    payload.targetIp = sessionDraft.restrictTarget ? optionalDraftString(sessionDraft.targetIp) : undefined;
  }
  if (sessionDraft.excludeCountries.length > 0 || sessionDraft.excludeCities.length > 0 || sessionDraft.preferredRegion) {
    payload.pathPolicy = {
      excludeCountries: sessionDraft.excludeCountries,
      excludeCities: sessionDraft.excludeCities,
      preferredRegions: sessionDraft.preferredRegion ? [sessionDraft.preferredRegion] : [],
      reason: "user-routing-policy"
    };
  }
  return payload;
}

async function revokeSession(id: string): Promise<void> {
  if (revokingConfigIds.has(id)) {
    return;
  }
  revokingConfigIds.add(id);
  render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  try {
    await api(`/v1/public/sessions/${id}/revoke`, { method: "POST" });
    log(`Revoke requested for VPN config ${id}. Waiting for gates to remove it.`);
    await refresh({ skipAutoMeasure: true });
    await pollRevokedConfig(id);
  } catch (error) {
    revokingConfigIds.delete(id);
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    log(error instanceof Error ? error.message : `Could not revoke VPN config ${id}.`);
  }
}

async function deleteVpnConfig(id: string): Promise<void> {
  if (deletingConfigIds.has(id)) {
    return;
  }
  deletingConfigIds.add(id);
  render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  try {
    const session = latestSessions.find((entry) => entry.id === id);
    if (session?.phase !== "failed") {
      const revoked = await ensureVpnConfigRevoked(id);
      if (!revoked) {
        throw new Error(`VPN config ${id} was not revoked before delete.`);
      }
    }
    await api(`/v1/public/sessions/${id}`, { method: "DELETE" });
    deletingConfigIds.delete(id);
    revokingConfigIds.delete(id);
    latestSessions = latestSessions.filter((session) => session.id !== id);
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    log(`VPN config ${id} deleted from this list.`);
    await refresh({ skipAutoMeasure: true });
  } catch (error) {
    deletingConfigIds.delete(id);
    revokingConfigIds.delete(id);
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    log(error instanceof Error ? error.message : `Could not delete VPN config ${id}.`);
  }
}

async function downloadArtifact(id: string): Promise<void> {
  const tokenResponse = await api(`/v1/public/sessions/${id}/artifacts/client-config/download-token`, { method: "POST" });
  const artifact = await api(tokenResponse.downloadUrl, { method: "GET" });
  const payload = artifact.payload ?? {};
  if (typeof payload.configText !== "string") {
    log(JSON.stringify(artifact, null, 2));
    return;
  }
  downloadTextFile(
    typeof payload.fileName === "string" ? payload.fileName : `hyperspace-${id.slice(0, 8)}.conf`,
    payload.configText
  );
  log("Client configuration downloaded.");
}

async function showConfigQr(id: string): Promise<void> {
  try {
    activeConfigQrSvg = await fetchConfigQrSvg(id);
    activeConfigQrSessionId = id;
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  } catch (error) {
    log(error instanceof Error ? error.message : "Could not generate WireGuard QR code.");
  }
}

async function fetchConfigQrSvg(id: string): Promise<string> {
  const tokenResponse = await api(`/v1/public/sessions/${id}/artifacts/client-config/download-token`, { method: "POST" });
  const response = await fetch(apiUrl(`${tokenResponse.downloadUrl}?format=qr`), {
    headers: { accept: "image/svg+xml" },
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error("Could not generate WireGuard QR code.");
  }
  return response.text();
}

async function downloadConnectHelper(id: string): Promise<void> {
  try {
    const tokenResponse = await api(`/v1/public/sessions/${id}/artifacts/client-config/download-token`, { method: "POST" });
    const configUrl = apiUrl(tokenResponse.downloadConfigUrl);
    const platform = detectedHelperPlatform();
    downloadTextFile(
      platform === "windows" ? "hyperspace-connect.ps1" : platform === "macos" ? "hyperspace-connect.command" : "hyperspace-connect.sh",
      connectHelperScript(platform, configUrl)
    );
    log(`Downloaded ${platformLabel(platform)} connect helper. Run it within five minutes.`);
  } catch (error) {
    log(error instanceof Error ? error.message : "Could not create connect helper.");
  }
}

function detectedHelperPlatform(): "linux" | "macos" | "windows" {
  const value = `${navigator.userAgent} ${(navigator as Navigator & { platform?: string }).platform ?? ""}`.toLowerCase();
  if (value.includes("win")) return "windows";
  if (value.includes("mac")) return "macos";
  return "linux";
}

function platformLabel(platform: "linux" | "macos" | "windows"): string {
  return platform === "windows" ? "Windows" : platform === "macos" ? "macOS" : "Linux";
}

function apiUrl(path: string): string {
  return new URL(`${apiBase}${path}`, window.location.origin).toString();
}

function connectHelperScript(platform: "linux" | "macos" | "windows", configUrl: string): string {
  if (platform === "windows") {
    return [
      "$ErrorActionPreference = 'Stop'",
      "$configPath = Join-Path $env:TEMP 'hyperspace.conf'",
      `Invoke-WebRequest -UseBasicParsing -Uri '${configUrl}' -OutFile $configPath`,
      "$wireGuard = Join-Path $env:ProgramFiles 'WireGuard\\wireguard.exe'",
      "if (-not (Test-Path $wireGuard)) { winget install --id WireGuard.WireGuard -e --accept-package-agreements --accept-source-agreements }",
      "Start-Process -FilePath $wireGuard -ArgumentList @('/installtunnelservice', $configPath) -Verb RunAs -Wait",
      "Write-Host 'Hyperspace tunnel installed and started.'"
    ].join("\r\n");
  }
  if (platform === "macos") {
    return [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "config_path=\"$HOME/Downloads/hyperspace.conf\"",
      `curl -fsSL '${configUrl}' -o \"$config_path\"`,
      "chmod 600 \"$config_path\"",
      "if [ -d /Applications/WireGuard.app ]; then open -a WireGuard \"$config_path\"; else echo 'Install WireGuard from the App Store, then open hyperspace.conf.'; open -R \"$config_path\"; fi"
    ].join("\n");
  }
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if ! command -v wg-quick >/dev/null; then",
    "  if command -v apt-get >/dev/null; then sudo apt-get update && sudo apt-get install -y wireguard-tools;",
    "  elif command -v dnf >/dev/null; then sudo dnf install -y wireguard-tools;",
    "  elif command -v pacman >/dev/null; then sudo pacman -Sy --noconfirm wireguard-tools;",
    "  else echo 'Install WireGuard tools first.' >&2; exit 1; fi",
    "fi",
    "tmp_config=$(mktemp)",
    "trap 'rm -f \"$tmp_config\"' EXIT",
    `curl -fsSL '${configUrl}' -o \"$tmp_config\"`,
    "sudo install -m 600 \"$tmp_config\" /etc/wireguard/hyperspace.conf",
    "sudo wg-quick down hyperspace >/dev/null 2>&1 || true",
    "sudo wg-quick up hyperspace",
    "echo 'Hyperspace tunnel is connected.'"
  ].join("\n");
}

async function getMe(): Promise<Me> {
  const response = await api("/v1/public/auth/me", { method: "GET" });
  return {
    ...response.user,
    billingAdmin: Array.isArray(response.capabilities) && response.capabilities.includes("billing:admin")
  };
}

async function getGates(): Promise<Gate[]> {
  const response = await api("/v1/public/gates", { method: "GET" });
  return response.gates;
}

async function getBenchmarkMatrix(): Promise<BenchmarkMatrix> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), benchmarkRequestTimeoutMs);
  try {
    return await api("/v1/public/benchmarks/gate-matrix", { method: "GET", signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

async function getSessions(): Promise<Session[]> {
  const response = await api("/v1/public/sessions", { method: "GET" });
  return response.sessions;
}

async function getBilling(): Promise<BillingSummary> {
  return api("/v1/public/billing", { method: "GET" });
}

async function getAdminBilling(): Promise<AdminBillingSummary> {
  return api("/v1/admin/billing/customers", { method: "GET" });
}

async function getAdminTraffic(): Promise<AdminTrafficSeries> {
  const query = new URLSearchParams({ range: adminTrafficRange });
  if (adminTrafficSessionId) query.set("sessionId", adminTrafficSessionId);
  return api(`/v1/admin/billing/traffic?${query.toString()}`, { method: "GET" });
}

async function refreshDashboardSessions(): Promise<void> {
  if (!token || currentView !== "dashboard" || sessionRefreshInFlight) {
    return;
  }
  sessionRefreshInFlight = true;
  try {
    latestSessions = await getSessions();
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  } catch {
    stopSessionAutoRefresh();
  } finally {
    sessionRefreshInFlight = false;
  }
}

function sessionNeedsAutoRefresh(session: Session): boolean {
  return (
    session.phase === "requested" ||
    session.phase === "scheduling" ||
    session.phase === "provisioning" ||
    session.phase === "revoking" ||
    revokingConfigIds.has(session.id) ||
    deletingConfigIds.has(session.id)
  );
}

async function pollRevokedConfig(id: string): Promise<void> {
  const attempts = 40;
  let lastPhase = latestSessions.find((session) => session.id === id)?.phase ?? "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await wait(1500);
    await refresh({ skipAutoMeasure: true });
    const session = latestSessions.find((entry) => entry.id === id);
    if (!session) {
      revokingConfigIds.delete(id);
      render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
      log(`VPN config ${id} is no longer listed.`);
      return;
    }
    if (session.phase === "revoked") {
      revokingConfigIds.delete(id);
      render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
      log(`VPN config ${id} revoked.`);
      return;
    }
    if (session.phase === "failed") {
      revokingConfigIds.delete(id);
      render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
      log(`VPN config ${id} revoke failed.`);
      return;
    }
    if (session.phase !== lastPhase) {
      lastPhase = session.phase;
      log(`VPN config ${id} status: ${session.phase}.`);
    }
  }
  revokingConfigIds.delete(id);
  render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  log(`VPN config ${id} is still ${lastPhase || "pending"}; refresh later to check final state.`);
}

async function ensureVpnConfigRevoked(id: string): Promise<boolean> {
  const session = latestSessions.find((entry) => entry.id === id);
  if (session?.phase === "revoked") {
    return true;
  }
  if (!revokingConfigIds.has(id)) {
    revokingConfigIds.add(id);
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    await api(`/v1/public/sessions/${id}/revoke`, { method: "POST" });
    log(`Revoke requested for VPN config ${id}. Waiting for gates to remove it.`);
    await refresh({ skipAutoMeasure: true });
  }
  await pollRevokedConfig(id);
  return latestSessions.find((entry) => entry.id === id)?.phase === "revoked";
}

async function getNetworkMe(): Promise<{ ip: string }> {
  return api("/v1/public/network/me", { method: "GET" });
}

async function api(path: string, options: { method: string; body?: unknown; signal?: AbortSignal }): Promise<any> {
  const headers = new Headers();
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  const init: RequestInit = {
    method: options.method,
    headers
  };
  if (options.signal) {
    init.signal = options.signal;
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(compact(options.body));
  }
  const response = await fetch(`${apiBase}${path}`, init);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    log(JSON.stringify(payload, null, 2));
    throw new ApiRequestError(payload.message ?? payload.error ?? response.statusText, payload.error ?? "http_error", response.status);
  }
  return payload;
}

class ApiRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function updateSessionDraftFromForm(form: HTMLFormElement): void {
  const formData = new FormData(form);
  sessionDraft.label = String(formData.get("label") ?? "");
  sessionDraft.restrictSource = formData.get("restrictSource") === "on";
  sessionDraft.sourceIp = String(formData.get("sourceIp") ?? "");
  sessionDraft.restrictTarget = formData.get("restrictTarget") === "on";
  syncSessionDraftMode();
  sessionDraft.targetIp = String(formData.get("targetIp") ?? "");
  sessionDraft.ingressGateName = String(formData.get("ingressGateName") ?? "");
  sessionDraft.egressGateName = String(formData.get("egressGateName") ?? "");
  sessionDraft.useClientPublicKey = formData.get("useClientPublicKey") === "on";
  if (formData.has("clientPublicKey")) {
    sessionDraft.clientPublicKey = String(formData.get("clientPublicKey") ?? "");
  }
  sessionDraft.excludeCountries = formData.getAll("excludeCountry").map(String);
  sessionDraft.excludeCities = formData.getAll("excludeCity").map(String);
  sessionDraft.preferredRegion = String(formData.get("preferredRegion") ?? "");
}

function syncSessionDraftMode(): void {
  sessionDraft.mode = sessionDraft.restrictTarget ? "IpToIp" : "FullTunnel";
}

function syncSessionFormControls(form: HTMLFormElement): void {
  const sourceCheckbox = form.elements.namedItem("restrictSource") as HTMLInputElement | null;
  const sourceInput = form.elements.namedItem("sourceIp") as HTMLInputElement | null;
  const sourceButton = document.getElementById("use-browser-source-ip") as HTMLButtonElement | null;
  const targetCheckbox = form.elements.namedItem("restrictTarget") as HTMLInputElement | null;
  const targetInput = form.elements.namedItem("targetIp") as HTMLInputElement | null;
  const ingressSelect = form.elements.namedItem("ingressGateName") as HTMLSelectElement | null;
  const egressSelect = form.elements.namedItem("egressGateName") as HTMLSelectElement | null;
  const modeLabel = document.getElementById("mode-label");
  const targetModeHelp = document.getElementById("target-mode-help");

  const sourceEnabled = sourceCheckbox?.checked === true;
  if (sourceInput) {
    sourceInput.disabled = !sourceEnabled;
  }
  if (sourceButton) {
    sourceButton.disabled = !sourceEnabled;
  }

  const targetInputEnabled = targetCheckbox?.checked === true;
  if (targetInput) {
    targetInput.disabled = !targetInputEnabled;
  }
  if (modeLabel) {
    modeLabel.textContent = routeTypeLabel(targetInputEnabled ? "IpToIp" : "FullTunnel", sourceEnabled);
  }
  if (targetModeHelp) {
    targetModeHelp.textContent = targetModeHelpText(targetInputEnabled, sourceEnabled);
  }

  if (ingressSelect && egressSelect) {
    for (const option of egressSelect.options) {
      option.disabled = option.value !== "" && option.value === ingressSelect.value;
    }
    if (egressSelect.value === ingressSelect.value) {
      egressSelect.value = "";
    }
  }
}

async function fillBrowserSourceIp(): Promise<void> {
  const form = document.getElementById("session-form") as HTMLFormElement | null;
  if (!form) {
    return;
  }
  updateSessionDraftFromForm(form);
  try {
    const network = await getNetworkMe();
    browserIp = network.ip || "";
    if (!browserIp) {
      log("Could not detect browser IPv4 address.");
      return;
    }
    const input = form.elements.namedItem("sourceIp") as HTMLInputElement | null;
    if (input) {
      input.value = browserIp;
    }
    const checkbox = form.elements.namedItem("restrictSource") as HTMLInputElement | null;
    if (checkbox) {
      checkbox.checked = true;
    }
    updateSessionDraftFromForm(form);
    syncSessionFormControls(form);
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    log(`Browser IP detected: ${browserIp}`);
  } catch (error) {
    log(error instanceof Error ? error.message : "Could not detect browser IPv4 address.");
  }
}

async function copyKeyInstructionScript(button: HTMLButtonElement): Promise<void> {
  const script = keyInstructionScript(keyInstructionPlatform);
  await copyScriptToClipboard(button, script, {
    copiedLabel: "Copied key generation script",
    copyLabel: "Copy key generation script",
    successLog: "WireGuard key generation script copied.",
    failureLog: "Could not copy the key generation script."
  });
}

async function copyClientPublicKey(button: HTMLButtonElement): Promise<void> {
  await copyScriptToClipboard(button, sessionDraft.clientPublicKey.trim(), {
    copiedLabel: "Copied client public key",
    copyLabel: "Copy client public key",
    successLog: "Client public key copied.",
    failureLog: "Could not copy the client public key."
  });
}

async function copyScriptToClipboard(
  button: HTMLButtonElement,
  script: string,
  labels: { copiedLabel: string; copyLabel: string; successLog: string; failureLog: string }
): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(script);
    } else {
      fallbackCopyText(script);
    }
    const originalTitle = button.title || "Copy";
    button.classList.add("copied");
    button.title = "Copied";
    button.setAttribute("aria-label", labels.copiedLabel);
    window.setTimeout(() => {
      button.classList.remove("copied");
      button.title = originalTitle;
      button.setAttribute("aria-label", labels.copyLabel);
    }, 1400);
    log(labels.successLog);
  } catch {
    log(labels.failureLog);
  }
}

function fallbackCopyText(text: string): void {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function measureAndRefreshGates(): Promise<void> {
  if (gateLatencyMeasurementInFlight) {
    return;
  }
  const measurementEmail = latestMe?.email;
  if (!measurementEmail) {
    return;
  }
  if (latestGates.length === 0) {
    await refresh({ skipAutoMeasure: true });
  }
  if (latestGates.length === 0) {
    return;
  }
  const renderMeasurementState = () => {
    if (latestMe?.email === measurementEmail && currentView === "dashboard") {
      render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    }
  };
  gateLatencyMeasurementInFlight = true;
  gateLatencyInProgressIds.clear();
  for (const gate of latestGates) {
    gateLatencyInProgressIds.add(gate.id);
  }
  renderMeasurementState();
  log("Measuring browser RTT to gate probe endpoints...");
  try {
    await Promise.all(latestGates.map(async (gate) => {
      const stats = await measureGateLatency(gate);
      gateLatencyById.set(gate.id, stats);
      gateLatencyInProgressIds.delete(gate.id);
      renderMeasurementState();
    }));
  } finally {
    gateLatencyInProgressIds.clear();
    gateLatencyMeasurementInFlight = false;
    renderMeasurementState();
  }
  if (latestMe?.email !== measurementEmail || currentView !== "dashboard") {
    return;
  }
  await refresh({ skipAutoMeasure: true });
  log("Browser RTT measurements refreshed.");
}

function maybeMeasureGatesAutomatically(): void {
  if (!latestMe || currentView !== "dashboard" || automaticGateLatencyMeasurementStarted || gateLatencyMeasurementInFlight || latestGates.length === 0) {
    return;
  }
  automaticGateLatencyMeasurementStarted = true;
  runGateLatencyMeasurement();
}

async function measureGateLatency(gate: Gate): Promise<{ medianMs: number | null; minMs: number | null; maxMs: number | null; sampleCount: number }> {
  const probeUrl = gateProbeUrl(gate);
  if (!probeUrl) {
    return { medianMs: null, minMs: null, maxMs: null, sampleCount: 0 };
  }
  const samples: number[] = [];
  await measureProbeHead(probeUrl, "warmup");
  for (let index = 0; index < 5; index += 1) {
    const sample = await measureProbeHead(probeUrl, `${index}`);
    if (sample !== null) {
      samples.push(sample);
    }
    await wait(80);
  }
  if (samples.length === 0) {
    return { medianMs: null, minMs: null, maxMs: null, sampleCount: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
  return {
    medianMs: roundLatency(medianMs),
    minMs: roundLatency(Math.min(...samples)),
    maxMs: roundLatency(Math.max(...samples)),
    sampleCount: samples.length
  };
}

function runGateLatencyMeasurement(): void {
  void measureAndRefreshGates().catch((error) => {
    gateLatencyInProgressIds.clear();
    gateLatencyMeasurementInFlight = false;
    if (latestMe && currentView !== "login" && currentView !== "register") {
      render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    }
    log(error instanceof Error ? error.message : "Browser RTT measurement failed.");
  });
}

async function measureProbeHead(probeUrl: string, sampleId: string): Promise<number | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => {
    controller.abort(new DOMException("probe_timeout", "AbortError"));
  }, 2500);
  const url = new URL(probeUrl);
  url.searchParams.set("ts", `${Date.now()}-${sampleId}-${Math.random().toString(16).slice(2)}`);
  const startedAt = performance.now();
  try {
    const response = await fetch(url.toString(), {
      method: "HEAD",
      mode: "cors",
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) {
      return null;
    }
    return performance.now() - startedAt;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function gateProbeUrl(gate: Gate): string | null {
  return gate.probeUrl ?? null;
}

function decorateGates(gates: Gate[]): Gate[] {
  return gates.map((gate) => {
    const stats = gateLatencyById.get(gate.id);
    if (gateLatencyInProgressIds.has(gate.id)) {
      return {
        ...gate,
        browserLatencyStatus: "measuring"
      };
    }
    if (!stats) {
      return gate;
    }
    return {
      ...gate,
      browserLatencyMs: stats.medianMs,
      browserLatencyStatus: stats.medianMs === null ? "unavailable" : "measured"
    };
  });
}

function sortIngressGates(gates: Gate[]): Gate[] {
  return [...gates].sort((a, b) => {
    const aLatency = a.browserLatencyMs;
    const bLatency = b.browserLatencyMs;
    if (aLatency == null && bLatency != null) {
      return 1;
    }
    if (bLatency == null && aLatency != null) {
      return -1;
    }
    if (aLatency != null && bLatency != null) {
      return aLatency - bLatency;
    }
    return a.name.localeCompare(b.name);
  });
}

function sortGates(gates: Gate[], field: GateSortField, direction: SortDirection): Gate[] {
  return [...gates].sort((a, b) => {
    let cmp = 0;
    if (field === "clock-error") {
      cmp = compareOptionalNumber(a.clockErrorMs, b.clockErrorMs, direction);
    } else {
      cmp = compareOptionalNumber(a.browserLatencyMs ?? undefined, b.browserLatencyMs ?? undefined, direction);
    }
    if (cmp !== 0) {
      return cmp;
    }
    return a.name.localeCompare(b.name);
  });
}

function ensureSessionDraftGateSelection(ingressGates: Gate[], egressGates: Gate[]): void {
  if (ingressGates.length === 0) {
    sessionDraft.ingressGateName = "";
    sessionDraft.egressGateName = "";
    return;
  }
  if (!ingressGateManuallySelected || !ingressGates.some((gate) => gate.name === sessionDraft.ingressGateName)) {
    sessionDraft.ingressGateName = ingressGates[0]?.name ?? "";
  }
  const validEgressGates = egressGates.filter((gate) => gate.name !== sessionDraft.ingressGateName);
  if (!validEgressGates.some((gate) => gate.name === sessionDraft.egressGateName)) {
    sessionDraft.egressGateName = "";
  }
}

function gateOptionLabel(gate: Gate, includeLatency: boolean): string {
  const latency = includeLatency ? `, ${latencyText(gate)}` : "";
  return `${gate.name} - ${gateLocationLabel(gate)}${latency}`;
}

function gateLocationLabel(gate: Gate): string {
  const city = gate.city?.trim();
  const country = gate.country?.trim();
  if (city && country) {
    return `${city}, ${country}`;
  }
  return city || country || "unknown location";
}

function draftRouteTypeLabel(): string {
  return routeTypeLabel(sessionDraft.mode, sessionDraft.restrictSource);
}

function sessionRouteTypeLabel(session: Session): string {
  const mode = session.mode === "FullTunnel" || session.destinationCidrs.includes("0.0.0.0/0") ? "FullTunnel" : "IpToIp";
  return routeTypeLabel(mode, Boolean(session.sourceCidr));
}

function routeTypeLabel(mode: SessionMode, restrictSource: boolean): string {
  if (mode === "FullTunnel") {
    return restrictSource ? "Source-restricted full tunnel" : "Full tunnel";
  }
  return restrictSource ? "Source-to-target route" : "Target-restricted route";
}

function targetModeHelpText(restrictTarget: boolean, restrictSource: boolean): string {
  if (restrictTarget && restrictSource) {
    return "Only the selected source IP can reach the selected target /32.";
  }
  if (restrictTarget) {
    return "Any source IP can reach only the selected target /32.";
  }
  if (restrictSource) {
    return "Full tunnel routes all IPv4 destinations, restricted to the selected source IP.";
  }
  return "Full tunnel routes all IPv4 destinations, so target IP is not used.";
}

function latencyCell(gate: Gate): string {
  if (gateLatencyInProgressIds.has(gate.id)) {
    return '<div class="latency-result"><strong class="muted">measuring...</strong><small>probe in progress</small></div>';
  }
  const stats = gateLatencyById.get(gate.id);
  if (!stats) {
    return '<div class="latency-result"><strong class="muted">not measured</strong><small>measure to sort by RTT</small></div>';
  }
  if (stats.medianMs === null) {
    return '<div class="latency-result"><strong class="muted">n/a</strong><small>probe unavailable</small></div>';
  }
  return `<div class="latency-result"><strong>${formatLatency(stats.medianMs)}ms</strong><small>min ${formatLatency(stats.minMs)}ms / max ${formatLatency(stats.maxMs)}ms</small></div>`;
}

function doubleZeroNodeCell(gate: Gate): string {
  const status = gate.doubleZero;
  if (!status) {
    return '<div class="latency-result"><strong class="muted">not reported</strong><small>waiting for heartbeat</small></div>';
  }
  if (status.error) {
    return `<div class="latency-result"><strong class="muted">unavailable</strong><small title="${escapeHtml(status.error)}">${escapeHtml(trimCellText(status.error, 44))}</small></div>`;
  }
  const currentDevice = status.currentDevice?.trim() ?? "";
  if (!currentDevice) {
    return '<div class="latency-result"><strong class="muted">not reported</strong><small>current device missing</small></div>';
  }
  const lowestLatencyDevice = doubleZeroLatencyDeviceLabel(status);
  const detailParts = [
    status.metro?.trim(),
    status.network?.trim(),
    lowestLatencyDevice ? `Lowest latency device: ${lowestLatencyDevice}` : ""
  ].filter(Boolean);
  const title = status.reportedAt ? `Reported at ${status.reportedAt}` : "";
  return `<div class="latency-result" title="${escapeHtml(title)}"><strong class="mono">${escapeHtml(currentDevice)}</strong><small>${escapeHtml(detailParts.join(" / ") || "DoubleZero current device")}</small></div>`;
}

function doubleZeroLatencyDeviceLabel(status: GateDoubleZeroStatus): string {
  const device = status.lowestLatencyDevice?.trim();
  if (!device) {
    return "";
  }
  if (status.lowestLatencyDeviceWarning === true) {
    return `⚠️ ${device}`;
  }
  if (status.lowestLatencyDeviceWarning === false) {
    return `✅ ${device}`;
  }
  return device;
}

function trimCellText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function latencyText(gate: Gate): string {
  const stats = gateLatencyById.get(gate.id);
  if (!stats) {
    return "RTT not measured";
  }
  if (stats.medianMs === null) {
    return "RTT n/a";
  }
  return `RTT ${formatLatency(stats.medianMs)}ms`;
}

function sourceIpCell(session: Session): string {
  if (!session.sourceCidr) {
    return '<span class="empty-marker">Any</span>';
  }
  return `<span class="mono">${escapeHtml(ipLabelFromCidr(session.sourceCidr))}</span>`;
}

function targetIpCell(session: Session): string {
  if (session.mode === "FullTunnel" || session.destinationCidrs.includes("0.0.0.0/0")) {
    return '<span class="empty-marker">Internet</span>';
  }
  if (session.destinationCidrs.length === 0) {
    return '<span class="empty-marker">Target not set</span>';
  }
  const labels = session.destinationCidrs.map(ipLabelFromCidr);
  return `<span class="mono">${escapeHtml(labels.join(", "))}</span>`;
}

function gateNameCell(value: string | undefined): string {
  if (!value) {
    return '<span class="empty-marker">pending</span>';
  }
  const displayValue = value.startsWith("gate-") ? value.slice("gate-".length) : value;
  return `<span class="mono" title="${escapeHtml(value)}">${escapeHtml(displayValue)}</span>`;
}

function ipLabelFromCidr(value: string): string {
  return value.endsWith("/32") ? value.slice(0, -3) : value;
}

function createdAtCell(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return '<span class="empty-marker">Unknown</span>';
  }
  const date = new Date(timestamp);
  const label = `${date.getUTCFullYear()}-${padDatePart(date.getUTCMonth() + 1)}-${padDatePart(date.getUTCDate())} ${padDatePart(date.getUTCHours())}:${padDatePart(date.getUTCMinutes())} UTC`;
  return `<time datetime="${escapeHtml(date.toISOString())}" title="${escapeHtml(date.toISOString())}">${escapeHtml(label)}</time>`;
}

function padDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatLatency(value: number | null): string {
  return value == null ? "n/a" : `${roundLatency(value)}`;
}

function roundLatency(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatFixedLatency(value: number, fractionDigits: number): string {
  return value.toFixed(fractionDigits);
}

function compact(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== "")
  );
}

function optionalDraftString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}

function consumeOauthTokenFromLocation(): string {
  if (!window.location.hash.startsWith("#")) {
    return "";
  }
  const params = new URLSearchParams(window.location.hash.slice(1));
  const accessToken = params.get("access_token") ?? "";
  if (!accessToken) {
    return "";
  }
  window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}`);
  localStorage.setItem("hyperspaceAccessToken", accessToken);
  return accessToken;
}

function formatMoneyMinor(amountMinor: number, currency: string): string {
  if (currency.toUpperCase() === "SOL") {
    return `${formatTokenBaseUnits(String(Math.max(0, Math.trunc(amountMinor))), 9)} SOL`;
  }
  const amount = amountMinor / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function billingBalanceText(billing: BillingSummary | null): string {
  if (billing?.deposit?.tokenSymbol === "SOL" && billing.walletSpendableBaseUnits !== null) {
    return `${formatTokenBaseUnits(billing.walletSpendableBaseUnits, billing.deposit.tokenDecimals)} SOL`;
  }
  return formatMoneyMinor(billing?.availableBalanceMinor ?? billing?.balanceMinor ?? 0, billing?.currency ?? "USD");
}

function configPriceText(): string {
  const baseUnits = latestBilling?.configPriceBaseUnits || "100000";
  const decimals = latestBilling?.deposit?.tokenDecimals ?? 9;
  return `${formatTokenBaseUnits(baseUnits, decimals)} SOL`;
}

function formatDurationSeconds(seconds: number): string {
  const total = Math.max(0, Math.trunc(seconds));
  if (total < 3600) return `${Math.max(1, Math.round(total / 60))} min`;
  if (total < 86400) return `${(total / 3600).toFixed(total % 3600 === 0 ? 0 : 1)} h`;
  return `${(total / 86400).toFixed(total % 86400 === 0 ? 0 : 1)} d`;
}

function formatByteCount(bytes: bigint): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "n/a";
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  return `${(value / 1_000_000_000).toFixed(2)} GB`;
}

function shortWallet(publicKey: string): string {
  return publicKey.length <= 12 ? publicKey : `${publicKey.slice(0, 4)}...${publicKey.slice(-4)}`;
}

function shortTransaction(signature: string): string {
  return signature.length <= 18 ? signature : `${signature.slice(0, 8)}...${signature.slice(-8)}`;
}

function formatTokenBaseUnits(value: string, decimals: number): string {
  const baseUnits = BigInt(value);
  const safeDecimals = Math.max(0, Math.trunc(decimals));
  if (safeDecimals === 0) return baseUnits.toString();
  const padded = baseUnits.toString().padStart(safeDecimals + 1, "0");
  const whole = padded.slice(0, -safeDecimals);
  const fraction = padded.slice(-safeDecimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function isIpv4(value: string): boolean {
  const parts = value.trim().split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const octet = Number(part);
    return octet >= 0 && octet <= 255;
  });
}

function isWireGuardPublicKey(value: string): boolean {
  const trimmed = value.trim();
  if (!wireGuardCanonicalBase64Pattern.test(trimmed)) {
    return false;
  }
  try {
    const decoded = atob(trimmed);
    return decoded.length === 32 && !isAllZeroBinaryString(decoded);
  } catch {
    return false;
  }
}

function isAllZeroBinaryString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0) {
      return false;
    }
  }
  return value.length > 0;
}

function statusDot(value: boolean): string {
  return `<span class="${value ? "ok" : "bad"}">${value ? "yes" : "no"}</span>`;
}

function log(message: string): void {
  eventLogLines.unshift(message);
  eventLogLines.splice(80);
  const target = document.getElementById("event-log");
  if (target) {
    target.textContent = eventLogLines.join("\n");
  }
}

function downloadTextFile(fileName: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#039;";
      default:
        return char;
    }
  });
}
