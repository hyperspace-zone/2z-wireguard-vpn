/** Bounded, fail-closed counters. Never evict a live bucket to admit a new identity. */
export class WindowLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;
  constructor(private readonly capacity = 10_000) {}
  consume(key: string, max: number, windowMs: number, now = Date.now()): { allowed: boolean; remaining: number; resetAt: number } {
    let bucket = this.buckets.get(key);
    if (bucket && bucket.resetAt <= now) { this.buckets.delete(key); bucket = undefined; }
    if (!bucket) {
      if (this.buckets.size >= this.capacity && now - this.lastSweep >= 1000) {
        this.lastSweep = now;
        for (const [identity, value] of this.buckets) if (value.resetAt <= now) this.buckets.delete(identity);
      }
      if (this.buckets.size >= this.capacity) return { allowed: false, remaining: 0, resetAt: now + 1000 };
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count = Math.min(max + 1, bucket.count + 1);
    return { allowed: bucket.count <= max, remaining: Math.max(0, max - bucket.count), resetAt: bucket.resetAt };
  }
  get size(): number { return this.buckets.size; }
}
