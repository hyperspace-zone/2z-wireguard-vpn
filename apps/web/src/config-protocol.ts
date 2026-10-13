import type { ClientProtocol } from "@hyperspace-zone/contracts";

export function configProtocolFromSearch(search: string): ClientProtocol | null {
  const values = new URLSearchParams(search).getAll("protocol");
  if (values.length === 0) return "wireguard";
  if (values.length !== 1) return null;
  if (values[0] === "wireguard") return "wireguard";
  if (values[0] === "amnezia") return "amneziawg";
  return null;
}

export function createConfigPath(protocol: ClientProtocol | null, tradingRouteId = ""): string {
  const params = new URLSearchParams();
  if (protocol !== "wireguard") params.set("protocol", protocol === "amneziawg" ? "amnezia" : "invalid");
  if (tradingRouteId) params.set("tradingRoute", tradingRouteId);
  return `/create-config${params.size ? `?${params}` : ""}`;
}

// Only an interrupted sign-in resumes this path. It never becomes the default
// for a later visit to /create-config or a normal navigation link.
export function pendingConfigPath(stored: string | null, now = Date.now()): string | null {
  try {
    const value = JSON.parse(stored ?? "null");
    if (!value || typeof value.path !== "string" || typeof value.createdAt !== "number") return null;
    const age = now - value.createdAt;
    if (!Number.isFinite(age) || age < 0 || age >= 24 * 60 * 60_000) return null;
    const url = new URL(value.path, "https://local.invalid");
    if (!value.path.startsWith("/create-config") || url.origin !== "https://local.invalid" || url.pathname !== "/create-config" || url.hash) return null;
    return url.pathname + url.search;
  } catch {
    return null;
  }
}
