import timers from "node:timers/promises";

export function log(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ...payload, now: new Date().toISOString() })}\n`);
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await timers.setTimeout(ms, undefined, { signal });
  } catch (error) {
    // Cancelling a worker interval is normal shutdown, not a failed loop.
    if (!signal?.aborted || !(error instanceof Error) || error.name !== "AbortError") {
      throw error;
    }
  }
}
