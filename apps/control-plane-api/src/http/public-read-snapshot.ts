import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RuntimeMetrics } from "@hyperspace-zone/shared";

export type PublicSnapshotState = "live" | "refreshing" | "stale";
interface Options {
  now?: () => number;
  freshMs?: number;
  maxAgeMs?: number;
  retryMs?: number;
  maxBytes?: number;
  metrics?: RuntimeMetrics;
  onFailure?: () => void;
}

/** One fixed read model, never a cache keyed by untrusted query strings.
 * A single background refresh is shared by all readers. No unbounded queues,
 * no financial/assignment state, no rewriting original measurement timestamps.
 */
export class PublicReadSnapshot<T> {
  private value: { data: T; at: number; etag: string } | undefined;
  private pending: Promise<void> | undefined;
  private retryAt = 0;
  private failed = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;
  private readonly freshMs: number;
  private readonly maxAgeMs: number;
  constructor(private readonly name: "benchmarks" | "trading", private readonly load: () => Promise<T>, private readonly options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.freshMs = options.freshMs ?? 10_000;
    this.maxAgeMs = options.maxAgeMs ?? 60_000;
    options.metrics?.gauge("public_measurement_snapshot_updated_at_seconds", 0, {
      help: "Last successful bounded public measurement snapshot refresh.", labels: { snapshot: name }
    });
  }
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.now() < this.retryAt) return Promise.reject(new Error("Public snapshot refresh is in backoff"));
    const started = this.now();
    const work = Promise.resolve().then(this.load).then(data => {
      const json = JSON.stringify(data);
      if (Buffer.byteLength(json) > (this.options.maxBytes ?? 2_097_152)) throw new Error("Public snapshot exceeds memory budget");
      this.value = { data, at: this.now(), etag: `W/"${createHash("sha256").update(json).digest("hex")}"` };
      this.failed = false;
      this.retryAt = 0;
      this.options.metrics?.gauge("public_measurement_snapshot_updated_at_seconds", this.value.at / 1000, {
        help: "Last successful bounded public measurement snapshot refresh.", labels: { snapshot: this.name }
      });
    }).catch(() => {
      if (!this.failed) this.options.onFailure?.();
      this.failed = true;
      this.retryAt = this.now() + (this.options.retryMs ?? 5000);
      // Do not propagate driver/SQL errors (which can contain credentials).
      throw new Error("Public measurements are temporarily unavailable");
    }).finally(() => {
      this.options.metrics?.histogram("public_measurement_snapshot_refresh_seconds", Math.max(0, this.now() - started) / 1000, {
        help: "Background public snapshot refresh duration.", labels: { snapshot: this.name }, buckets: [.005, .01, .025, .05, .1, .25, 1, 2, 5]
      });
      this.options.metrics?.counter("public_measurement_snapshot_refresh_total", 1, {
        help: "Public measurement snapshot refresh outcomes.", labels: { snapshot: this.name, outcome: this.failed ? "failed" : "succeeded" }
      });
      if (this.pending === work) this.pending = undefined;
    });
    this.pending = work;
    return work;
  }
  async read(): Promise<{ data: T; state: PublicSnapshotState; ageSeconds: number; etag: string }> {
    let age = this.value ? this.now() - this.value.at : Infinity;
    if ((!this.value || age >= this.freshMs) && !this.pending && this.now() >= this.retryAt) void this.refresh().catch(() => undefined);
    if (!this.value || age < 0 || age > this.maxAgeMs) {
      if (this.pending) await this.pending;
      age = this.value ? this.now() - this.value.at : Infinity;
      if (!this.value || age < 0 || age > this.maxAgeMs) throw new Error("Public measurements are temporarily unavailable");
    }
    return { data: this.value.data, etag: this.value.etag, ageSeconds: Math.floor(age / 1000),
      state: this.failed ? "stale" : age >= this.freshMs ? "refreshing" : "live" };
  }
  start(): void {
    const tick = async () => {
      try { await this.refresh(); } catch { /* bounded retry; last-good value remains timestamped */ }
      if (!this.stopped) { this.timer = setTimeout(() => void tick(), this.failed ? 5000 : this.freshMs); this.timer.unref(); }
    };
    void tick();
  }
  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending?.catch(() => undefined);
    this.value = undefined;
  }
}

/** Only successful anonymous display data is eligible for shared caching.
 * Error/stale/authenticated responses and route/purchase validation stay no-store.
 */
export function publicSnapshotHeaders(request: FastifyRequest, reply: FastifyReply,
  snapshot: { state: PublicSnapshotState; ageSeconds: number; etag: string }, variant = ""): boolean {
  const etag = variant ? `W/"${createHash("sha256").update(`${snapshot.etag}:${variant}`).digest("hex")}"` : snapshot.etag;
  reply.header("X-Hyperspace-Snapshot-State", snapshot.state)
    .header("X-Hyperspace-Snapshot-Age", String(snapshot.ageSeconds))
    .header("ETag", etag);
  const anonymous = !request.headers.authorization && !request.headers.cookie;
  reply.header("Cache-Control", snapshot.state === "live" && anonymous
    ? "public, max-age=0, s-maxage=5, must-revalidate" : "no-store");
  // Never answer 304 from an expired/failed model. Do not attach a payload to 304.
  if (snapshot.state === "live" && request.headers["if-none-match"] === etag) {
    reply.code(304).send();
    return true;
  }
  return false;
}
