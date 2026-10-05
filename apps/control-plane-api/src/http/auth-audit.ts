import { createHmac } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RuntimeMetrics } from "@hyperspace-zone/shared";
import { asRecord, clientIpForSecurity } from "./request.js";

const outcomes = new WeakMap<object, string>();
export function setAuthOutcome(request: FastifyRequest, reason: string): void { outcomes.set(request, reason); }
export function emailAuditHash(email: string, secret: string): string {
  return createHmac("sha256", secret).update(email.trim().toLowerCase()).digest("hex");
}

/** One immediate event per IP/action/outcome per minute, followed by exact counts.
 * Emails, user agents, query strings, credentials and Turnstile tokens are never logged.
 * Raw IPs belong only in restricted logs, never in Prometheus labels.
 */
export function registerAuthAudit(app: FastifyInstance, secret: string, metrics?: RuntimeMetrics): void {
  const buckets = new Map<string, { event: Record<string, unknown>; count: number; until: number }>();
  const flush = () => {
    const now = Date.now();
    for (const [key, bucket] of buckets) if (bucket.until <= now) {
      if (bucket.count > 1) app.log.info({ ...bucket.event, event: "auth_security_summary", additional_requests: bucket.count - 1 });
      buckets.delete(key);
    }
  };
  const timer = setInterval(flush, 10_000); timer.unref();
  app.addHook("onClose", async () => { clearInterval(timer); for (const bucket of buckets.values()) {
    if (bucket.count > 1) app.log.info({ ...bucket.event, event: "auth_security_summary", additional_requests: bucket.count - 1 });
  } buckets.clear(); });
  app.addHook("onResponse", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/v1/public/auth/")) return;
    const route = request.routeOptions.url ?? "unknown_auth_route";
    const reason = outcomes.get(request) ?? (reply.statusCode < 400 ? "accepted" : `http_${reply.statusCode}`);
    const ip = clientIpForSecurity(request);
    const body = asRecord(request.body);
    const email = typeof body.email === "string" ? body.email.slice(0, 254) : "";
    const emailHash = email ? emailAuditHash(email, secret) : "";
    metrics?.counter("auth_security_requests_total", 1, { labels: { action: route, reason }, help: "Auth outcomes without client or recipient labels." });
    // Do not include the email hash in the bucket key: rotating emails must not flood logs.
    const key = `${ip}:${route}:${reason}:${reply.statusCode}`;
    const bucket = buckets.get(key);
    if (bucket && bucket.until > Date.now()) { bucket.count++; return; }
    if (bucket && bucket.count > 1) app.log.info({ ...bucket.event, event: "auth_security_summary", additional_requests: bucket.count - 1 });
    if (buckets.size >= 2000) {
      flush();
      if (buckets.size >= 2000) { metrics?.counter("auth_audit_overflow_total", 1); return; }
    }
    const event = { event: "auth_security_request", request_id: request.id, client_ip: ip, action: route,
      method: request.method, status: reply.statusCode, reason,
      ...(emailHash ? { email_hash: emailHash } : {}) };
    app.log.info(event);
    buckets.set(key, { event, count: 1, until: Date.now() + 60_000 });
  });
}
