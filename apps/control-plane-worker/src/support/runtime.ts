export function log(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ...payload, now: new Date().toISOString() })}\n`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
