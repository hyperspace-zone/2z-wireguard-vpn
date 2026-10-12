// Cache read-only admin counters, never payment authorization or user balances.
export function createAsyncReadCache<T>(ttlMs: number, maxEntries = 32, now = Date.now) {
  const entries = new Map<string, { promise: Promise<T>; expiresAt: number }>();
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const cached = entries.get(key);
      if (cached && cached.expiresAt > now()) return cached.promise;
      entries.delete(key);
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
      const entry = { promise: Promise.resolve().then(load), expiresAt: Infinity };
      entries.set(key, entry);
      void entry.promise.then(() => {
        entry.expiresAt = now() + ttlMs;
      }, () => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      return entry.promise;
    },
    clear(): void { entries.clear(); }
  };
}
