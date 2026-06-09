export function auditDetails(details: Record<string, unknown> = {}): string {
  return JSON.stringify(details);
}
