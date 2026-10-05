interface SecurityConfig { turnstileEnabled: boolean; turnstileSiteKey: string }
interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  remove(id: string): void;
}
declare global { interface Window { turnstile?: TurnstileApi } }
let configPromise: Promise<SecurityConfig> | null = null;
let scriptPromise: Promise<void> | null = null;
let widgetId: string | null = null;

export function disposeAuthSecurity(): void {
  if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
  widgetId = null;
}
async function loadScript(): Promise<void> {
  if (window.turnstile) return;
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    const timer = window.setTimeout(() => reject(new Error("Security check timed out. Reload the page or use Google.")), 15_000);
    script.onload = () => { window.clearTimeout(timer); resolve(); };
    script.onerror = () => { window.clearTimeout(timer); reject(new Error("Could not load the security check. Reload the page or use Google.")); };
    document.head.appendChild(script);
  });
  return scriptPromise;
}
export async function mountAuthSecurity(container: HTMLElement): Promise<void> {
  const form = container.closest("form");
  const button = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!form || !button) return;
  button.disabled = true;
  try {
    configPromise ??= fetch("/api/v1/public/auth/security", { cache: "no-store", signal: AbortSignal.timeout(8000) })
      .then(async response => { if (!response.ok) throw new Error("Security configuration unavailable."); return response.json() as Promise<SecurityConfig>; });
    const config = await configPromise;
    if (!container.isConnected) return;
    if (!config.turnstileEnabled) { container.textContent = ""; button.disabled = false; return; }
    if (!config.turnstileSiteKey) throw new Error("Security configuration unavailable.");
    await loadScript();
    if (!container.isConnected) return;
    container.textContent = "";
    const token = document.createElement("input"); token.type = "hidden"; token.name = "turnstileToken"; form.appendChild(token);
    widgetId = window.turnstile!.render(container, {
      sitekey: config.turnstileSiteKey, action: container.dataset.action, theme: "light", "response-field": false,
      callback: (value: string) => { token.value = value; button.disabled = !value; },
      "expired-callback": () => { token.value = ""; button.disabled = true; },
      "error-callback": () => { token.value = ""; button.disabled = true; }
    });
  } catch (error) { if (container.isConnected) container.textContent = error instanceof Error ? error.message : "Security check unavailable. Use Google or reload."; }
}
