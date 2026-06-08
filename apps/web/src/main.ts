type SessionMode = "IpToIp" | "FullTunnel";
type AppView = "dashboard" | "create-config" | "login" | "register";
type CreateConfigStep = "configure" | "confirm";
type SortDirection = "desc" | "asc";
type KeyInstructionPlatform = "linux" | "macos" | "windows";
type SessionValidationErrors = Partial<Record<"sourceIp" | "targetIp" | "ingressGateName" | "egressGateName" | "clientPublicKey", string>>;

interface Gate {
  id: string;
  name: string;
  region: string;
  city?: string;
  country?: string;
  countryCode?: string;
  publicEndpoint: string;
  probeUrl?: string;
  doubleZero?: GateDoubleZeroStatus;
  ready: boolean;
  schedulable: boolean;
  browserLatencyMs?: number | null;
  browserLatencyStatus?: "measured" | "unavailable" | "measuring";
}

interface GateDoubleZeroStatus {
  currentDevice?: string;
  lowestLatencyDevice?: string;
  metro?: string;
  network?: string;
  reportedAt?: string;
  error?: string;
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

const apiBase = (window as unknown as { HYPERSPACE_API_BASE?: string }).HYPERSPACE_API_BASE ?? "/api";
const wireGuardCanonicalBase64Pattern = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
let token = localStorage.getItem("hyperspaceAccessToken") ?? "";
let latestGates: Gate[] = [];
let latestSessions: Session[] = [];
let latestMe: { email: string } | null = null;
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
let gateBrowserRttSortDirection: SortDirection = "asc";
let sessionValidationErrors: SessionValidationErrors = {};
let ingressGateManuallySelected = false;
let keyInstructionPlatform: KeyInstructionPlatform = "linux";
let runInstructionPlatform: KeyInstructionPlatform = "linux";
const eventLogLines: string[] = [];

const sessionDraft = {
  mode: "IpToIp" as SessionMode,
  label: "",
  restrictSource: false,
  sourceIp: "",
  restrictTarget: true,
  targetIp: "",
  ingressGateName: "",
  egressGateName: "",
  useClientPublicKey: false,
  clientPublicKey: ""
};

const root = document.getElementById("app");
if (!root) {
  throw new Error("missing #app");
}
const appRoot = root;

renderLoading();
window.addEventListener("popstate", () => {
  currentView = viewFromLocation();
  if (currentView !== "create-config") {
    createConfigStep = "configure";
  }
  render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
});
void refresh();

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
  const [gates, sessions, me] = await Promise.all([
    getGates().catch(() => [] as Gate[]),
    token ? getSessions().catch(() => [] as Session[]) : Promise.resolve([]),
    token ? getMe().catch(() => null) : Promise.resolve(null)
  ]);
  latestGates = gates;
  latestSessions = sessions;
  latestMe = me;
  render({ gates: decorateGates(gates), sessions, me });
  if (!options.skipAutoMeasure && me) {
    maybeMeasureGatesAutomatically();
  }
}

function render(state: { gates?: Gate[]; sessions?: Session[]; me?: { email: string } | null } = {}): void {
  const gates = state.gates ?? [];
  const sessions = state.sessions ?? [];
  const me = state.me ?? null;
  const view = resolveViewForAuth(me);
  appRoot.innerHTML = `
    <main class="shell">
      <section class="topbar">
        <div>
          <h1>DoubleZero WireGuard VPN</h1>
          <p>DoubleZero-backed WireGuard configs across Hyperspace gates.</p>
        </div>
        <div class="identity">
          ${me ? `<span>${escapeHtml(me.email)}</span><button id="logout">Log out</button>` : "<span>Signed out</span>"}
        </div>
      </section>

      ${me ? appNav(view) : authNav(view)}
      ${renderView({ view, gates, sessions })}

      ${shouldShowEventLog(view) ? `<pre id="event-log" class="event-log">${escapeHtml(eventLogLines.join("\n"))}</pre>` : ""}
    </main>
  `;
  bindHandlers();
  syncSessionAutoRefresh(view, me, sessions);
}

function syncSessionAutoRefresh(view: AppView, me: { email: string } | null, sessions: Session[]): void {
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
    createConfigStep = "configure";
  }
  window.history.pushState({}, "", viewPath(view));
  render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
}

function viewFromLocation(): AppView {
  if (window.location.pathname === "/create-config") {
    return "create-config";
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
  if (view === "login") {
    return "/login";
  }
  if (view === "register") {
    return "/register";
  }
  return "/";
}

function resolveViewForAuth(me: { email: string } | null): AppView {
  let view = currentView;
  if (!me && view !== "login" && view !== "register") {
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

function renderView(state: { view: AppView; gates: Gate[]; sessions: Session[] }): string {
  if (state.view === "login") {
    return loginView();
  }
  if (state.view === "register") {
    return registerView();
  }
  if (state.view === "create-config") {
    return createConfigView(state.gates);
  }
  return dashboardView({ gates: state.gates, sessions: state.sessions });
}

function shouldShowEventLog(view: AppView): boolean {
  return view !== "login" && view !== "register";
}

function isAppView(value: string | undefined): value is AppView {
  return value === "dashboard" || value === "create-config" || value === "login" || value === "register";
}

function isKeyInstructionPlatform(value: string | undefined): value is KeyInstructionPlatform {
  return value === "linux" || value === "macos" || value === "windows";
}

function appNav(view: AppView): string {
  return `
    <nav class="app-nav" aria-label="Primary">
      <a href="/" data-view="dashboard" class="${view === "dashboard" ? "active" : ""}">Dashboard</a>
      <a href="/create-config" data-view="create-config" class="${view === "create-config" ? "active" : ""}">Create config</a>
    </nav>
  `;
}

function authNav(view: AppView): string {
  return `
    <nav class="app-nav" aria-label="Authentication">
      <a href="/login" data-view="login" class="${view === "login" ? "active" : ""}">Log in</a>
      <a href="/register" data-view="register" class="${view === "register" ? "active" : ""}">Register</a>
    </nav>
  `;
}

function dashboardView(state: { gates: Gate[]; sessions: Session[] }): string {
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
      ${gatesPanel(state.gates)}
    </section>
  `;
}

function createConfigView(gates: Gate[]): string {
  const title = createConfigStep === "confirm" ? "Review VPN config" : "Create VPN config";
  return `
    <section class="panel primary-panel">
      <div class="panel-heading">
        <h2>${title}</h2>
        <a class="button-link secondary-button" href="/" data-view="dashboard">Dashboard</a>
      </div>
      ${createConfigStep === "confirm" ? createConfigConfirmationPanel(gates) : createSessionPanel(gates)}
    </section>
  `;
}

function loginView(): string {
  return `
    <section class="panel auth-panel">
      <form id="login-form" class="auth-form">
        <div>
          <h2>Log in</h2>
          <p>Use your account to manage issued WireGuard configs.</p>
        </div>
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

function gatesPanel(gates: Gate[]): string {
  if (gates.length === 0) {
    return "<p>No gates loaded.</p>";
  }
  const sortedGates = sortGatesByBrowserLatency(gates, gateBrowserRttSortDirection);
  const measureButtonLabel = gateLatencyMeasurementInFlight ? "Measuring..." : "Measure browser RTT";
  const measureButtonDisabled = gateLatencyMeasurementInFlight ? "disabled" : "";
  const sortArrow = gateBrowserRttSortDirection === "desc" ? "↓" : "↑";
  const sortLabel = gateBrowserRttSortDirection === "desc" ? "high to low" : "low to high";
  return `
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Region</th>
          <th>Endpoint</th>
          <th>DoubleZero node</th>
          <th>Online</th>
          <th>Schedulable</th>
          <th aria-sort="${gateBrowserRttSortDirection === "desc" ? "descending" : "ascending"}">
            <button class="table-sort" type="button" data-sort-gates="browser-rtt">Browser RTT ${sortArrow}</button>
          </th>
        </tr>
      </thead>
      <tbody>
        ${sortedGates
          .map(
            (gate) => `
              <tr>
                <td>${escapeHtml(gate.name)}</td>
                <td>${escapeHtml(gate.region)}${gateLocationLabel(gate) !== gate.region ? `<small>${escapeHtml(gateLocationLabel(gate))}</small>` : ""}</td>
                <td><small class="mono">${escapeHtml(gate.publicEndpoint)}</small></td>
                <td>${doubleZeroNodeCell(gate)}</td>
                <td>${statusDot(gate.ready)}</td>
                <td>${statusDot(gate.schedulable)}</td>
                <td class="latency-cell">${latencyCell(gate)}</td>
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
    <div class="panel-actions">
      <button id="measure-gates" type="button" ${measureButtonDisabled}>${measureButtonLabel}</button>
      <small>Sorted by Browser RTT, ${sortLabel}.</small>
    </div>
  `;
}

function createSessionPanel(gates: Gate[]): string {
  const schedulableGates = gates.filter((gate) => gate.ready && gate.schedulable);
  const ingressGates = sortIngressGates(schedulableGates);
  ensureSessionDraftGateSelection(ingressGates, schedulableGates);
  const ingressOptions = ingressGates.length === 0
    ? '<option value="" disabled selected>No ingress gates available</option>'
    : ingressGates
    .map((gate) => `<option value="${escapeHtml(gate.name)}" ${sessionDraft.ingressGateName === gate.name ? "selected" : ""}>${escapeHtml(gateOptionLabel(gate, true))}</option>`)
    .join("");
  const egressCandidates = schedulableGates.filter((gate) => gate.name !== sessionDraft.ingressGateName);
  const egressOptions = egressCandidates.length === 0
    ? '<option value="" disabled selected>No distinct egress gate available</option>'
    : [
      `<option value="" disabled ${sessionDraft.egressGateName ? "" : "selected"}>Select egress gate</option>`,
      ...egressCandidates.map((gate) => `<option value="${escapeHtml(gate.name)}" ${sessionDraft.egressGateName === gate.name ? "selected" : ""}>${escapeHtml(gateOptionLabel(gate, false))}</option>`)
    ].join("");
  syncSessionDraftMode();
  const targetChecked = sessionDraft.restrictTarget;
  const modeLabel = draftRouteTypeLabel();
  return `
    <div class="configure-step">
      <p class="step-caption">Create VPN config - Step 1: Configure route and keys</p>
      <form id="session-form" class="session-form" novalidate>
        <label>Config name <input name="label" placeholder="workstation to service" value="${escapeHtml(sessionDraft.label)}" /></label>
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
            <input name="sourceIp" placeholder="203.0.113.10" value="${escapeHtml(sessionDraft.sourceIp)}" ${sessionDraft.restrictSource ? "" : "disabled"} ${sessionValidationErrors.sourceIp ? 'aria-invalid="true"' : ""} />
            <button id="use-browser-source-ip" type="button" ${sessionDraft.restrictSource ? "" : "disabled"}>Use browser IP</button>
          </div>
          ${fieldError("sourceIp")}
          <small>${browserIp ? `Current browser IP: ${escapeHtml(browserIp)}` : "Source restriction is optional; enable it when this config is for the same public network you are using now."}</small>
        </fieldset>
        <fieldset class="form-group">
          <label class="checkbox-line">
            <input name="restrictTarget" type="checkbox" ${targetChecked ? "checked" : ""} />
            <span>Restrict destination to target IP</span>
          </label>
          <input name="targetIp" placeholder="198.51.100.20" value="${escapeHtml(sessionDraft.targetIp)}" ${targetChecked ? "" : "disabled"} ${sessionValidationErrors.targetIp ? 'aria-invalid="true"' : ""} />
          <small id="target-mode-help">${escapeHtml(targetModeHelpText(targetChecked, sessionDraft.restrictSource))}</small>
          ${fieldError("targetIp")}
        </fieldset>
        <div class="gate-select-row">
          <label>Ingress
            <select name="ingressGateName" required ${sessionValidationErrors.ingressGateName ? 'aria-invalid="true"' : ""}>
              ${ingressOptions}
            </select>
            ${fieldError("ingressGateName")}
            <small>Ingress candidates are sorted by browser RTT when probes are available.</small>
          </label>
          <label>Egress
            <select name="egressGateName" required ${sessionValidationErrors.egressGateName ? 'aria-invalid="true"' : ""}>
              ${egressOptions}
            </select>
            ${fieldError("egressGateName")}
          </label>
        </div>
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
  const policyText = sessionDraft.mode === "FullTunnel"
    ? `${sourceLabel} enters through the selected ingress, crosses DoubleZero, and exits to the Internet through the selected egress.`
    : `${sourceLabel} can reach only ${destinationLabel} through the selected ingress, DoubleZero transit, and selected egress.`;
  const buttonLabel = createConfigSubmitting ? "Creating..." : "Confirm and create";
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
          </div>
        </div>
      </div>

      <div class="policy-panel">
        <h3>Tunnel policy</h3>
        <p>${escapeHtml(policyText)}</p>
      </div>

      ${sessionDraft.mode === "FullTunnel" ? fullTunnelAlertPanel() : ""}
      ${sessionDraft.useClientPublicKey ? clientKeyReplacementNotice() : ""}
      ${runInstructionsPanel()}

      <div class="form-actions">
        <button id="edit-config" class="secondary-button" type="button" ${disabled}>Back to edit</button>
        <button id="confirm-create-config" class="success-button" type="button" ${disabled}>${buttonLabel}</button>
      </div>
    </div>
  `;
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
      <p>If you enable this config on a remote machine that you access over SSH or RDP, the current SSH/RDP session can disconnect because traffic may move into the VPN. Use the smoke-test command below first; it brings the tunnel up briefly and then shuts it down.</p>
    </div>
  `;
}

function runInstructionsPanel(): string {
  const script = runInstructionScript(runInstructionPlatform);
  return `
    <section class="run-instructions" aria-label="How to run">
      <div class="key-instructions-header">
        <div>
          <h3>How to run</h3>
          <p>After creating and downloading the config, save it as <span class="mono">hyperspace.conf</span> and run a short smoke test.</p>
        </div>
      </div>
      <div class="key-instruction-tabs" role="tablist" aria-label="Run platform">
        ${runInstructionTab("linux", "Linux")}
        ${runInstructionTab("macos", "macOS")}
        ${runInstructionTab("windows", "Windows")}
      </div>
      <div class="key-script-wrap">
        <button id="copy-run-script" class="copy-code-button" type="button" aria-label="Copy terminal run script" title="Copy">
          <span class="copy-icon" aria-hidden="true"></span>
        </button>
        <pre class="key-script"><code>${highlightKeyScript(script, runInstructionPlatform)}</code></pre>
      </div>
    </section>
  `;
}

function runInstructionTab(platform: KeyInstructionPlatform, label: string): string {
  const active = runInstructionPlatform === platform;
  return `
    <button class="key-instruction-tab ${active ? "active" : ""}" type="button" role="tab" aria-selected="${active ? "true" : "false"}" data-run-instruction-tab="${platform}">
      ${escapeHtml(label)}
    </button>
  `;
}

function runInstructionScript(platform: KeyInstructionPlatform): string {
  if (platform === "windows") {
    return [
      "$ErrorActionPreference = \"Stop\"",
      "$config = \"$HOME\\Downloads\\hyperspace.conf\"",
      "$wireguard = \"$env:ProgramFiles\\WireGuard\\wireguard.exe\"",
      "",
      "& $wireguard /installtunnelservice $config",
      "Start-Sleep -Seconds 5",
      "curl.exe ifconfig.me",
      "Start-Sleep -Seconds 5",
      "& $wireguard /uninstalltunnelservice hyperspace"
    ].join("\n");
  }
  return [
    "sudo wg-quick up ./hyperspace.conf",
    "sleep 5",
    "curl ifconfig.me",
    "sleep 5",
    "sudo wg-quick down ./hyperspace.conf"
  ].join("\n");
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
    subvalue: `${gateLocationLabel(gate)}, ${gate.publicEndpoint}`
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
    latestMe = null;
    latestSessions = [];
    stopSessionAutoRefresh();
    localStorage.removeItem("hyperspaceAccessToken");
    window.history.replaceState({}, "", viewPath("login"));
    void refresh();
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
    void submitAuth("/v1/public/auth/register", form);
  });

  document.getElementById("login-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.target as HTMLFormElement);
    void submitAuth("/v1/public/auth/login", form);
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
      if (fieldName === "ingressGateName") {
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
  for (const button of document.querySelectorAll("[data-run-instruction-tab]")) {
    button.addEventListener("click", () => {
      const platform = (button as HTMLElement).dataset.runInstructionTab;
      if (!isKeyInstructionPlatform(platform)) {
        return;
      }
      runInstructionPlatform = platform;
      render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    });
  }
  document.getElementById("copy-key-script")?.addEventListener("click", (event) => {
    void copyKeyInstructionScript(event.currentTarget as HTMLButtonElement);
  });
  document.getElementById("copy-run-script")?.addEventListener("click", (event) => {
    void copyRunInstructionScript(event.currentTarget as HTMLButtonElement);
  });
  document.getElementById("copy-client-public-key")?.addEventListener("click", (event) => {
    void copyClientPublicKey(event.currentTarget as HTMLButtonElement);
  });
  document.getElementById("edit-config")?.addEventListener("click", () => {
    createConfigStep = "configure";
    sessionValidationErrors = {};
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  document.getElementById("confirm-create-config")?.addEventListener("click", () => {
    void createSession();
  });
  document.getElementById("measure-gates")?.addEventListener("click", () => {
    runGateLatencyMeasurement();
  });
  document.querySelector("[data-sort-gates='browser-rtt']")?.addEventListener("click", () => {
    gateBrowserRttSortDirection = gateBrowserRttSortDirection === "desc" ? "asc" : "desc";
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
}

async function submitAuth(path: string, form: FormData): Promise<void> {
  const response = await api(path, {
    method: "POST",
    body: {
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? "")
    }
  });
  token = response.accessToken;
  currentView = "dashboard";
  createConfigStep = "configure";
  localStorage.setItem("hyperspaceAccessToken", token);
  window.history.replaceState({}, "", viewPath("dashboard"));
  log("Signed in.");
  await refresh();
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
  sessionValidationErrors = {};
  render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  try {
    await api("/v1/public/sessions", { method: "POST", body: sessionPayloadFromDraft() });
    createConfigSubmitting = false;
    createConfigStep = "configure";
    navigateToView("dashboard");
    log("VPN config requested.");
    await refresh();
  } catch (error) {
    createConfigSubmitting = false;
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    log(error instanceof Error ? error.message : "Could not create VPN config.");
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

async function getMe(): Promise<{ email: string }> {
  const response = await api("/v1/public/auth/me", { method: "GET" });
  return response.user;
}

async function getGates(): Promise<Gate[]> {
  const response = await api("/v1/public/gates", { method: "GET" });
  return response.gates;
}

async function getSessions(): Promise<Session[]> {
  const response = await api("/v1/public/sessions", { method: "GET" });
  return response.sessions;
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

async function api(path: string, options: { method: string; body?: unknown }): Promise<any> {
  const headers = new Headers();
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  const init: RequestInit = {
    method: options.method,
    headers
  };
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(compact(options.body));
  }
  const response = await fetch(`${apiBase}${path}`, init);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    log(JSON.stringify(payload, null, 2));
    throw new Error(payload.error ?? response.statusText);
  }
  return payload;
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

async function copyRunInstructionScript(button: HTMLButtonElement): Promise<void> {
  const script = runInstructionScript(runInstructionPlatform);
  await copyScriptToClipboard(button, script, {
    copiedLabel: "Copied terminal run script",
    copyLabel: "Copy terminal run script",
    successLog: "Terminal run script copied.",
    failureLog: "Could not copy the terminal run script."
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
  if (latestGates.length === 0) {
    await refresh({ skipAutoMeasure: true });
  }
  if (latestGates.length === 0) {
    return;
  }
  gateLatencyMeasurementInFlight = true;
  gateLatencyInProgressIds.clear();
  for (const gate of latestGates) {
    gateLatencyInProgressIds.add(gate.id);
  }
  render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  log("Measuring browser RTT to gate probe endpoints...");
  try {
    await Promise.all(latestGates.map(async (gate) => {
      const stats = await measureGateLatency(gate);
      gateLatencyById.set(gate.id, stats);
      gateLatencyInProgressIds.delete(gate.id);
      render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
    }));
  } finally {
    gateLatencyInProgressIds.clear();
    gateLatencyMeasurementInFlight = false;
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
  }
  await refresh({ skipAutoMeasure: true });
  log("Browser RTT measurements refreshed.");
}

function maybeMeasureGatesAutomatically(): void {
  if (!latestMe || automaticGateLatencyMeasurementStarted || gateLatencyMeasurementInFlight || latestGates.length === 0) {
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
    render({ gates: decorateGates(latestGates), sessions: latestSessions, me: latestMe });
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

function sortGatesByBrowserLatency(gates: Gate[], direction: SortDirection): Gate[] {
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
      return direction === "desc" ? bLatency - aLatency : aLatency - bLatency;
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
  return `${gate.name} - ${gateLocationLabel(gate)} (${gate.region}${latency})`;
}

function gateLocationLabel(gate: Gate): string {
  const city = gate.city?.trim();
  const country = gate.country?.trim();
  if (city && country) {
    return `${city}, ${country}`;
  }
  return city || country || gate.region;
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
  return `<div class="latency-result"><strong>${formatLatency(stats.medianMs)} ms</strong><small>min ${formatLatency(stats.minMs)} / max ${formatLatency(stats.maxMs)} ms</small></div>`;
}

function doubleZeroNodeCell(gate: Gate): string {
  const status = gate.doubleZero;
  if (!status) {
    return '<div class="latency-result"><strong class="muted">not reported</strong><small>waiting for heartbeat</small></div>';
  }
  if (status.error) {
    return `<div class="latency-result"><strong class="muted">unavailable</strong><small title="${escapeHtml(status.error)}">${escapeHtml(trimCellText(status.error, 44))}</small></div>`;
  }
  const currentDevice = status.currentDevice?.trim();
  if (!currentDevice) {
    return '<div class="latency-result"><strong class="muted">not reported</strong><small>current device missing</small></div>';
  }
  const detailParts = [
    status.metro?.trim(),
    status.network?.trim(),
    status.lowestLatencyDevice?.trim() ? `Lowest latency device: ${status.lowestLatencyDevice.trim()}` : ""
  ].filter(Boolean);
  const title = status.reportedAt ? `Reported at ${status.reportedAt}` : "";
  return `<div class="latency-result" title="${escapeHtml(title)}"><strong class="mono">${escapeHtml(currentDevice)}</strong><small>${escapeHtml(detailParts.join(" / ") || "DoubleZero current device")}</small></div>`;
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
