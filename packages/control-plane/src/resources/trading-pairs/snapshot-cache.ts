export type SnapshotState = "live" | "refreshing" | "stale";

// One in-flight refresh per database. Public reads may use a bounded last-good
// value; purchase validation always calls fresh() and never gets a fallback.
export class SnapshotCache<T> {
  private value: { data: T; at: number } | undefined;
  private pending: Promise<T> | undefined;
  private failed = false;
  private retryAt = 0;

  constructor(
    private readonly load: () => Promise<T>,
    private readonly now: () => number = Date.now,
    private readonly freshMs = 15_000,
    private readonly maxAgeMs = 120_000
  ) {}

  async read(): Promise<{ data: T; state: SnapshotState; ageSeconds: number }> {
    const age = this.value ? this.now() - this.value.at : Infinity;
    if (this.value && age >= 0 && age < this.freshMs) {
      return { data: this.value.data, state: "live", ageSeconds: Math.floor(age / 1000) };
    }
    if (!this.pending && this.now() >= this.retryAt) void this.fresh().catch(() => undefined);
    if (this.value && age >= 0 && age <= this.maxAgeMs) {
      return { data: this.value.data, state: this.failed ? "stale" : "refreshing", ageSeconds: Math.floor(age / 1000) };
    }
    if (this.pending) return { data: await this.pending, state: "live", ageSeconds: 0 };
    throw new Error("Trading snapshot refresh is temporarily unavailable");
  }

  fresh(): Promise<T> {
    if (this.pending) return this.pending;
    const work = Promise.resolve().then(this.load).then(data => {
      this.value = { data, at: this.now() };
      this.failed = false;
      this.retryAt = 0;
      return data;
    }, error => {
      this.failed = true;
      this.retryAt = this.now() + 5000;
      throw error;
    }).finally(() => { if (this.pending === work) this.pending = undefined; });
    this.pending = work;
    return work;
  }
}
