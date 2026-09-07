export function tradingRouteIntent(query: string | null, stored: string | null, now = Date.now()): string {
  if (query !== null) return /^[a-f0-9]{64}$/.test(query) ? query : "";
  try {
    const value = JSON.parse(stored ?? "null") as { id?: unknown; createdAt?: unknown } | null;
    if (!value || typeof value.id !== "string" || typeof value.createdAt !== "number") return "";
    const age = now - value.createdAt;
    return /^[a-f0-9]{64}$/.test(value.id) && age >= 0 && age < 24 * 60 * 60_000 ? value.id : "";
  } catch { return ""; }
}
