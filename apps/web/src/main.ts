type SessionMode = "IpToIp" | "FullTunnel";

interface Gate {
  id: string;
  name: string;
  region: string;
  ready: boolean;
  schedulable: boolean;
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
  createdAt: string;
}

const apiBase = (window as unknown as { HYPERSPACE_API_BASE?: string }).HYPERSPACE_API_BASE ?? "/api";
let token = localStorage.getItem("hyperspaceAccessToken") ?? "";

const root = document.getElementById("app");
if (!root) {
  throw new Error("missing #app");
}
const appRoot = root;

render();
void refresh();

async function refresh(): Promise<void> {
  const [gates, sessions, me] = await Promise.all([
    getGates().catch(() => [] as Gate[]),
    token ? getSessions().catch(() => [] as Session[]) : Promise.resolve([]),
    token ? getMe().catch(() => null) : Promise.resolve(null)
  ]);
  render({ gates, sessions, me });
}

function render(state: { gates?: Gate[]; sessions?: Session[]; me?: { email: string } | null } = {}): void {
  appRoot.innerHTML = `
    <main class="shell">
      <section class="topbar">
        <div>
          <h1>2z WireGuard VPN</h1>
          <p>DoubleZero-backed VPN sessions across Hyperspace gates.</p>
        </div>
        <div class="identity">
          ${state.me ? `<span>${escapeHtml(state.me.email)}</span><button id="logout">Log out</button>` : "<span>Signed out</span>"}
        </div>
      </section>

      <section class="grid">
        <div class="panel">
          <h2>Account</h2>
          ${state.me ? accountPanel() : authPanel()}
        </div>
        <div class="panel">
          <h2>Gates</h2>
          ${gatesPanel(state.gates ?? [])}
        </div>
      </section>

      <section class="panel">
        <h2>Create Session</h2>
        ${token ? createSessionPanel(state.gates ?? []) : "<p>Sign in to create VPN sessions.</p>"}
      </section>

      <section class="panel">
        <h2>Sessions</h2>
        ${token ? sessionsPanel(state.sessions ?? []) : "<p>Sign in to view sessions.</p>"}
      </section>

      <pre id="event-log" class="event-log"></pre>
    </main>
  `;
  bindHandlers();
}

function accountPanel(): string {
  return `<p>Your account can create, inspect, revoke, and download client config artifacts.</p>`;
}

function authPanel(): string {
  return `
    <div class="auth-grid">
      <form id="register-form">
        <h3>Register</h3>
        <label>Email <input name="email" type="email" required /></label>
        <label>Password <input name="password" type="password" minlength="12" required /></label>
        <button type="submit">Register</button>
      </form>
      <form id="login-form">
        <h3>Log in</h3>
        <label>Email <input name="email" type="email" required /></label>
        <label>Password <input name="password" type="password" required /></label>
        <button type="submit">Log in</button>
      </form>
    </div>
  `;
}

function gatesPanel(gates: Gate[]): string {
  if (gates.length === 0) {
    return "<p>No gates loaded.</p>";
  }
  return `
    <table>
      <thead><tr><th>Name</th><th>Region</th><th>Ready</th><th>Schedulable</th></tr></thead>
      <tbody>
        ${gates
          .map(
            (gate) => `
              <tr>
                <td>${escapeHtml(gate.name)}</td>
                <td>${escapeHtml(gate.region)}</td>
                <td>${statusDot(gate.ready)}</td>
                <td>${statusDot(gate.schedulable)}</td>
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function createSessionPanel(gates: Gate[]): string {
  const gateOptions = gates
    .map((gate) => `<option value="${escapeHtml(gate.name)}">${escapeHtml(gate.name)} (${escapeHtml(gate.region)})</option>`)
    .join("");
  return `
    <form id="session-form" class="session-form">
      <label>Mode
        <select name="mode">
          <option value="IpToIp">IP to IP</option>
          <option value="FullTunnel">Full tunnel</option>
        </select>
      </label>
      <label>Label <input name="label" placeholder="workstation to service" /></label>
      <label>Source IP <input name="sourceIp" placeholder="203.0.113.10" /></label>
      <label>Target IP <input name="targetIp" placeholder="198.51.100.20" /></label>
      <label>Ingress
        <select name="ingressGateName">
          <option value="">Auto</option>
          ${gateOptions}
        </select>
      </label>
      <label>Egress
        <select name="egressGateName">
          <option value="">Auto</option>
          ${gateOptions}
        </select>
      </label>
      <label>TTL seconds <input name="ttlSeconds" type="number" min="60" max="2592000" placeholder="3600" /></label>
      <label>Client public key <input name="clientPublicKey" placeholder="optional WireGuard public key" /></label>
      <button type="submit">Create VPN session</button>
    </form>
  `;
}

function sessionsPanel(sessions: Session[]): string {
  if (sessions.length === 0) {
    return "<p>No sessions yet.</p>";
  }
  return `
    <table>
      <thead><tr><th>Session</th><th>Mode</th><th>Phase</th><th>Path</th><th>Actions</th></tr></thead>
      <tbody>
        ${sessions
          .map(
            (session) => `
              <tr>
                <td>
                  <strong>${escapeHtml(session.label || session.id.slice(0, 8))}</strong>
                  <small>${escapeHtml(session.destinationCidrs.join(", "))}</small>
                </td>
                <td>${escapeHtml(session.mode)}</td>
                <td>${escapeHtml(session.phase)}</td>
                <td>${escapeHtml(pathLabel(session))}</td>
                <td>
                  <button data-download="${escapeHtml(session.id)}">Download</button>
                  <button data-revoke="${escapeHtml(session.id)}">Revoke</button>
                </td>
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function bindHandlers(): void {
  document.getElementById("logout")?.addEventListener("click", () => {
    token = "";
    localStorage.removeItem("hyperspaceAccessToken");
    void refresh();
  });

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
    const form = new FormData(event.target as HTMLFormElement);
    void createSession(form);
  });

  for (const button of document.querySelectorAll("[data-revoke]")) {
    button.addEventListener("click", () => {
      const id = (button as HTMLElement).dataset.revoke;
      if (id) void revokeSession(id);
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
  localStorage.setItem("hyperspaceAccessToken", token);
  log("Signed in.");
  await refresh();
}

async function createSession(form: FormData): Promise<void> {
  const mode = String(form.get("mode") ?? "IpToIp") as SessionMode;
  const payload: Record<string, unknown> = {
    mode,
    label: optional(form, "label"),
    sourceIp: optional(form, "sourceIp"),
    ingressGateName: optional(form, "ingressGateName"),
    egressGateName: optional(form, "egressGateName"),
    ttlSeconds: optionalNumber(form, "ttlSeconds"),
    clientPublicKey: optional(form, "clientPublicKey")
  };
  if (mode === "IpToIp") {
    payload.targetIp = optional(form, "targetIp");
  }
  await api("/v1/public/sessions", { method: "POST", body: payload });
  log("Session requested.");
  await refresh();
}

async function revokeSession(id: string): Promise<void> {
  await api(`/v1/public/sessions/${id}/revoke`, { method: "POST" });
  log(`Revoke requested for ${id}.`);
  await refresh();
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

async function api(path: string, options: { method: string; body?: unknown }): Promise<any> {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  const init: RequestInit = {
    method: options.method,
    headers
  };
  if (options.body !== undefined) {
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

function compact(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== "")
  );
}

function optional(form: FormData, key: string): string | undefined {
  const value = String(form.get(key) ?? "").trim();
  return value || undefined;
}

function optionalNumber(form: FormData, key: string): number | undefined {
  const value = optional(form, key);
  return value ? Number(value) : undefined;
}

function statusDot(value: boolean): string {
  return `<span class="${value ? "ok" : "bad"}">${value ? "yes" : "no"}</span>`;
}

function pathLabel(session: Session): string {
  const ingress = session.selectedPath?.ingressGateName ?? "pending";
  const egress = session.selectedPath?.egressGateName ?? "pending";
  return `${ingress} -> ${egress}`;
}

function log(message: string): void {
  const target = document.getElementById("event-log");
  if (target) {
    target.textContent = `${message}\n${target.textContent ?? ""}`;
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
