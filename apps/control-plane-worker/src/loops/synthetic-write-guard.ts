import type { Database } from "@hyperspace-zone/db";
import type { HealthRegistry, RuntimeMetrics } from "@hyperspace-zone/shared";

interface GuardResult {
  allowed: boolean;
  sizeBytes: number | null;
}

export function createSyntheticWriteGuard(input: {
  db: Database;
  health: HealthRegistry;
  metrics: RuntimeMetrics;
  hardLimitBytes: number;
  refreshMs: number;
}): { allowsWrites(): Promise<boolean> } {
  let cached: GuardResult | null = null;
  let cachedUntil = 0;
  let pending: Promise<GuardResult> | null = null;

  async function refresh(): Promise<GuardResult> {
    try {
      const result = await input.db.query<{ size_bytes: string }>(
        "SELECT pg_database_size(current_database())::text AS size_bytes"
      );
      const sizeBytes = Number(result.rows[0]?.size_bytes);
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new Error("PostgreSQL returned an invalid database size");
      }
      return { allowed: sizeBytes < input.hardLimitBytes, sizeBytes };
    } catch {
      return { allowed: false, sizeBytes: null };
    }
  }

  function publish(result: GuardResult): void {
    input.metrics.gauge("synthetic_writes_allowed", result.allowed ? 1 : 0, {
      help: "Whether database pressure permits new synthetic benchmark and trading jobs."
    });
    input.metrics.gauge("synthetic_write_hard_limit_bytes", input.hardLimitBytes, {
      help: "PostgreSQL size threshold that pauses new synthetic writes."
    });
    if (result.sizeBytes !== null) {
      input.metrics.gauge("synthetic_write_guard_database_size_bytes", result.sizeBytes, {
        help: "PostgreSQL database size observed by the synthetic write guard."
      });
    }
    input.health.setComponent("synthetic-write-guard", result.allowed ? {
      state: "ready",
      message: "Synthetic writes are below the PostgreSQL safety limit.",
      details: { sizeBytes: result.sizeBytes, hardLimitBytes: input.hardLimitBytes }
    } : {
      state: "degraded",
      message: result.sizeBytes === null
        ? "Synthetic writes are paused because PostgreSQL size could not be verified."
        : "Synthetic writes are paused by the PostgreSQL size safety limit.",
      details: { sizeBytes: result.sizeBytes, hardLimitBytes: input.hardLimitBytes }
    });
  }

  return {
    async allowsWrites(): Promise<boolean> {
      const now = Date.now();
      if (cached && now < cachedUntil) {
        publish(cached);
        return cached.allowed;
      }
      pending ??= refresh();
      cached = await pending;
      pending = null;
      cachedUntil = now + input.refreshMs;
      publish(cached);
      return cached.allowed;
    }
  };
}
