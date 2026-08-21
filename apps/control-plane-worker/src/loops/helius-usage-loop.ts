import type { RuntimeMetrics } from "@hyperspace-zone/shared";
import type { ControlPlaneWorkerConfig } from "../config.js";

interface HeliusUsagePayload {
  creditsRemaining: number;
  creditsUsed: number;
  prepaidCreditsRemaining?: number;
  subscriptionDetails: {
    creditsLimit: number;
    billingCycle: { end: string };
  };
}

export function createHeliusUsageLoop(
  config: ControlPlaneWorkerConfig,
  metrics: RuntimeMetrics,
  input: { fetchImpl?: typeof fetch; now?: () => number } = {}
): { due(): boolean; runOnce(): Promise<void> } {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const apiKey = readHeliusApiKey(config.billing.solanaHistoryRpcUrl ?? "");
  const configured = Boolean(apiKey && config.heliusUsage.projectId);
  let nextRunAt = 0;

  metrics.gauge("helius_usage_monitoring_configured", configured ? 1 : 0, {
    help: "Whether exact Helius project credit monitoring is configured."
  });

  return {
    due(): boolean {
      return configured && now() >= nextRunAt;
    },
    async runOnce(): Promise<void> {
      if (!configured || !apiKey) return;
      nextRunAt = now() + Math.max(60, config.heliusUsage.intervalSeconds) * 1000;
      try {
        const baseUrl = config.heliusUsage.adminApiBaseUrl.replace(/\/$/, "");
        const response = await fetchImpl(
          `${baseUrl}/v0/admin/projects/${encodeURIComponent(config.heliusUsage.projectId)}/usage`,
          { headers: { "X-Api-Key": apiKey } }
        );
        if (!response.ok) {
          throw new Error(`Helius Admin API request failed with HTTP ${response.status}`);
        }
        const payload = asHeliusUsagePayload(await response.json());
        const labels = { provider: "helius" };
        metrics.gauge("helius_credits_remaining", payload.creditsRemaining, {
          help: "Regular Helius credits remaining in the current credit cycle.", labels
        });
        metrics.gauge("helius_prepaid_credits_remaining", payload.prepaidCreditsRemaining ?? 0, {
          help: "Prepaid Helius credits remaining.", labels
        });
        metrics.gauge("helius_credits_used", payload.creditsUsed, {
          help: "Helius credits consumed in the current credit cycle.", labels
        });
        metrics.gauge("helius_credits_limit", payload.subscriptionDetails.creditsLimit, {
          help: "Regular Helius credit allowance for the current credit cycle.", labels
        });
        metrics.gauge("helius_credit_cycle_end_timestamp_seconds", parseTimestamp(payload.subscriptionDetails.billingCycle.end), {
          help: "Unix timestamp when the current Helius credit cycle ends.", labels
        });
        metrics.gauge("helius_usage_poll_ready", 1, {
          help: "Whether the latest Helius usage poll succeeded.", labels
        });
        metrics.gauge("helius_usage_last_success_timestamp_seconds", now() / 1000, {
          help: "Unix timestamp of the latest successful Helius usage poll.", labels
        });
      } catch (error) {
        metrics.gauge("helius_usage_poll_ready", 0, {
          help: "Whether the latest Helius usage poll succeeded.", labels: { provider: "helius" }
        });
        metrics.counter("helius_usage_poll_errors_total", 1, {
          help: "Total failed Helius usage polls.", labels: { provider: "helius" }
        });
        throw error;
      }
    }
  };
}

export function readHeliusApiKey(rpcUrl: string): string | null {
  try {
    const parsed = new URL(rpcUrl);
    if (!/(^|\.)helius-rpc\.com$/i.test(parsed.hostname)) return null;
    return parsed.searchParams.get("api-key") || null;
  } catch {
    return null;
  }
}

function asHeliusUsagePayload(value: unknown): HeliusUsagePayload {
  const payload = asRecord(value);
  const subscription = asRecord(payload.subscriptionDetails);
  const billingCycle = asRecord(subscription.billingCycle);
  const result: HeliusUsagePayload = {
    creditsRemaining: readNonNegativeNumber(payload.creditsRemaining, "creditsRemaining"),
    creditsUsed: readNonNegativeNumber(payload.creditsUsed, "creditsUsed"),
    subscriptionDetails: {
      creditsLimit: readPositiveNumber(subscription.creditsLimit, "subscriptionDetails.creditsLimit"),
      billingCycle: { end: String(billingCycle.end ?? "") }
    }
  };
  if (typeof payload.prepaidCreditsRemaining === "number") {
    result.prepaidCreditsRemaining = readNonNegativeNumber(payload.prepaidCreditsRemaining, "prepaidCreditsRemaining");
  }
  parseTimestamp(result.subscriptionDetails.billingCycle.end);
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function readNonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Helius Admin API returned invalid ${name}`);
  }
  return value;
}

function readPositiveNumber(value: unknown, name: string): number {
  const parsed = readNonNegativeNumber(value, name);
  if (parsed <= 0) throw new Error(`Helius Admin API returned invalid ${name}`);
  return parsed;
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("Helius Admin API returned an invalid billing cycle end");
  return timestamp / 1000;
}
