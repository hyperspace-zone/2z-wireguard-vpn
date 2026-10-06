export const readRequestTimeoutMs = 10_000;

export function shouldLoadAdminBilling(view: string): boolean {
  return view === "admin-billing";
}
