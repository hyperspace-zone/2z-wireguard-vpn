import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { bearerToken, detectClientIpv4, headerValue } from "./request.js";

export interface RateLimitPolicyConfig {
  maxRequests: number;
  windowSeconds: number;
}

export interface AbuseControlsConfig {
  enabled: boolean;
  authRegister: RateLimitPolicyConfig;
  authLogin: RateLimitPolicyConfig;
  publicMutation: RateLimitPolicyConfig;
  artifactDownload: RateLimitPolicyConfig;
  gate: RateLimitPolicyConfig;
  admin: RateLimitPolicyConfig;
}

interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetAtMs: number;
  retryAfterSeconds: number;
}

interface RateLimitBucket {
  count: number;
  resetAtMs: number;
}

export class InMemoryFixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private lastSweepMs = 0;

  consume(
    key: string,
    policy: RateLimitPolicyConfig,
    nowMs: number = Date.now()
  ): RateLimitDecision {
    this.sweepExpired(nowMs);

    const windowMs = policy.windowSeconds * 1000;
    const existing = this.buckets.get(key);
    const bucket = existing && existing.resetAtMs > nowMs
      ? existing
      : { count: 0, resetAtMs: nowMs + windowMs };

    if (bucket.count >= policy.maxRequests) {
      this.buckets.set(key, bucket);
      return {
        allowed: false,
        remaining: 0,
        resetAtMs: bucket.resetAtMs,
        retryAfterSeconds: retryAfterSeconds(bucket.resetAtMs, nowMs)
      };
    }

    bucket.count += 1;
    this.buckets.set(key, bucket);
    return {
      allowed: true,
      remaining: Math.max(policy.maxRequests - bucket.count, 0),
      resetAtMs: bucket.resetAtMs,
      retryAfterSeconds: 0
    };
  }

  private sweepExpired(nowMs: number): void {
    if (nowMs - this.lastSweepMs < 60_000) {
      return;
    }
    this.lastSweepMs = nowMs;
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.resetAtMs <= nowMs) {
        this.buckets.delete(key);
      }
    }
  }
}

interface AbusePolicy {
  name: string;
  limit: RateLimitPolicyConfig;
  match(method: string, path: string): boolean;
  key(request: FastifyRequest, path: string): string;
}

export function defaultAbuseControlsConfig(): AbuseControlsConfig {
  return {
    enabled: true,
    authRegister: { maxRequests: 5, windowSeconds: 60 * 60 },
    authLogin: { maxRequests: 20, windowSeconds: 15 * 60 },
    publicMutation: { maxRequests: 120, windowSeconds: 60 * 60 },
    artifactDownload: { maxRequests: 60, windowSeconds: 5 * 60 },
    gate: { maxRequests: 1_200, windowSeconds: 60 },
    admin: { maxRequests: 120, windowSeconds: 60 }
  };
}

export function registerAbuseControls(
  app: FastifyInstance,
  config: AbuseControlsConfig,
  limiter = new InMemoryFixedWindowRateLimiter()
): void {
  if (!config.enabled) {
    return;
  }

  const policies = createPolicies(config);
  app.addHook("onRequest", async (request, reply) => {
    const method = request.method.toUpperCase();
    const path = request.url.split("?", 1)[0] ?? request.url;
    for (const policy of policies) {
      if (!policy.match(method, path)) {
        continue;
      }
      const key = `${policy.name}:${policy.key(request, path)}`;
      const decision = limiter.consume(key, policy.limit);
      addRateLimitHeaders(reply, policy.limit, decision);
      if (!decision.allowed) {
        return reply.code(429).send({
          error: "rate_limited",
          message: "too many requests"
        });
      }
    }
  });
}

function createPolicies(config: AbuseControlsConfig): AbusePolicy[] {
  return [
    {
      name: "auth-register-ip",
      limit: config.authRegister,
      match: (method, path) => method === "POST" && path === "/v1/public/auth/register",
      key: (request) => clientIpKey(request)
    },
    {
      name: "auth-login-ip",
      limit: config.authLogin,
      match: (method, path) => method === "POST" && path === "/v1/public/auth/login",
      key: (request) => clientIpKey(request)
    },
    {
      name: "public-mutation-subject",
      limit: config.publicMutation,
      match: (method, path) => isPublicMutation(method, path),
      key: (request) => authenticatedSubjectKey(request)
    },
    {
      name: "artifact-download-ip",
      limit: config.artifactDownload,
      match: (method, path) => method === "GET" && path.startsWith("/v1/public/artifacts/download/"),
      key: (request) => clientIpKey(request)
    },
    {
      name: "artifact-download-token",
      limit: config.artifactDownload,
      match: (method, path) => method === "GET" && path.startsWith("/v1/public/artifacts/download/"),
      key: (_request, path) => `token:${hashForKey(path.slice("/v1/public/artifacts/download/".length))}`
    },
    {
      name: "admin-ip",
      limit: config.admin,
      match: (_method, path) => path.startsWith("/v1/admin/"),
      key: (request) => clientIpKey(request)
    },
    {
      name: "gate-subject",
      limit: config.gate,
      match: (_method, path) => path.startsWith("/v1/gate/"),
      key: (request) => gateSubjectKey(request)
    }
  ];
}

function isPublicMutation(method: string, path: string): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return false;
  }
  if (path === "/v1/public/auth/register" || path === "/v1/public/auth/login") {
    return false;
  }
  return path.startsWith("/v1/public/");
}

function clientIpKey(request: FastifyRequest): string {
  return `ip:${detectClientIpv4(request) || request.ip || "unknown"}`;
}

function authenticatedSubjectKey(request: FastifyRequest): string {
  const token = bearerToken(request);
  return token ? `bearer:${hashForKey(token)}` : clientIpKey(request);
}

function gateSubjectKey(request: FastifyRequest): string {
  const gateName = headerValue(request, "x-gate-name");
  return gateName ? `gate:${gateName}:${clientIpKey(request)}` : clientIpKey(request);
}

function hashForKey(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function addRateLimitHeaders(
  reply: FastifyReply,
  policy: RateLimitPolicyConfig,
  decision: RateLimitDecision
): void {
  reply
    .header("x-rate-limit-limit", String(policy.maxRequests))
    .header("x-rate-limit-remaining", String(decision.remaining))
    .header("x-rate-limit-reset", String(Math.ceil(decision.resetAtMs / 1000)));
  if (!decision.allowed) {
    reply.header("retry-after", String(decision.retryAfterSeconds));
  }
}

function retryAfterSeconds(resetAtMs: number, nowMs: number): number {
  return Math.max(Math.ceil((resetAtMs - nowMs) / 1000), 1);
}
