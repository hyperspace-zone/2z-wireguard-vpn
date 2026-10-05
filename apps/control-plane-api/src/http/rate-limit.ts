import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RuntimeMetrics } from "@hyperspace-zone/shared";
import { clientRateLimitIdentity } from "./request.js";
import { WindowLimiter } from "./window-limiter.js";
import { setAuthOutcome } from "./auth-audit.js";

export interface PublicRateLimitConfig {
  enabled: boolean;
  readWindowSeconds: number;
  readMax: number;
  authWindowSeconds: number;
  authMax: number;
  mutationWindowSeconds: number;
  mutationMax: number;
  downloadWindowSeconds: number;
  downloadMax: number;
}

type PublicRateLimitCategory = "read" | "auth" | "mutation" | "download";

interface RateLimitRule {
  windowSeconds: number;
  max: number;
}

export const defaultPublicRateLimitConfig: PublicRateLimitConfig = {
  enabled: true,
  readWindowSeconds: 60,
  readMax: 300,
  authWindowSeconds: 300,
  authMax: 30,
  mutationWindowSeconds: 60,
  mutationMax: 60,
  downloadWindowSeconds: 60,
  downloadMax: 30
};

export function registerPublicRateLimits(
  app: FastifyInstance,
  config: PublicRateLimitConfig,
  metrics?: RuntimeMetrics
): void {
  if (!config.enabled) {
    return;
  }

  const buckets = new WindowLimiter();
  app.addHook("onRequest", async (request, reply) => {
    const category = classifyPublicRequest(request);
    if (!category) {
      return;
    }

    const rule = ruleForCategory(config, category);
    if (rule.max <= 0 || rule.windowSeconds <= 0) {
      return sendRateLimitExceeded(reply, rule, Date.now() + 1000);
    }

    const now = Date.now();
    const key = `${category}:${clientRateLimitIdentity(request)}`;
    const bucket = buckets.consume(key, rule.max, rule.windowSeconds * 1000, now);
    setRateLimitHeaders(reply, rule, bucket.remaining, bucket.resetAt);
    if (!bucket.allowed) {
      setAuthOutcome(request, "ip_rate_limited");
      metrics?.counter("public_rate_limit_rejections_total", 1, {
        help: "Total public API requests rejected by in-process rate limiting.",
        labels: { category }
      });
      return sendRateLimitExceeded(reply, rule, bucket.resetAt);
    }
  });
}

function classifyPublicRequest(request: FastifyRequest): PublicRateLimitCategory | null {
  const path = request.url.split("?")[0] ?? "";
  if (!path.startsWith("/v1/public/")) {
    return null;
  }
  if (path.startsWith("/v1/public/auth/") && request.method !== "GET" && request.method !== "HEAD") {
    return "auth";
  }
  if (path.startsWith("/v1/public/artifacts/download/")) {
    return "download";
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return "mutation";
  }
  return "read";
}

function ruleForCategory(config: PublicRateLimitConfig, category: PublicRateLimitCategory): RateLimitRule {
  if (category === "auth") {
    return { windowSeconds: config.authWindowSeconds, max: config.authMax };
  }
  if (category === "mutation") {
    return { windowSeconds: config.mutationWindowSeconds, max: config.mutationMax };
  }
  if (category === "download") {
    return { windowSeconds: config.downloadWindowSeconds, max: config.downloadMax };
  }
  return { windowSeconds: config.readWindowSeconds, max: config.readMax };
}

function setRateLimitHeaders(
  reply: FastifyReply,
  rule: RateLimitRule,
  remaining: number,
  resetAtMs: number
): void {
  reply.header("x-ratelimit-limit", String(rule.max));
  reply.header("x-ratelimit-remaining", String(remaining));
  reply.header("x-ratelimit-reset", String(Math.ceil(resetAtMs / 1000)));
}

function sendRateLimitExceeded(reply: FastifyReply, rule: RateLimitRule, resetAtMs: number): FastifyReply {
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000));
  setRateLimitHeaders(reply, rule, 0, resetAtMs);
  return reply
    .code(429)
    .header("retry-after", String(retryAfterSeconds))
    .send({
      error: "rate_limited",
      message: `Too many requests. Retry after ${retryAfterSeconds} seconds.`
    });
}
