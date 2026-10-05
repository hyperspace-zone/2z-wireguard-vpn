import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "@hyperspace-zone/db";
import { reserveEmailSend, readEmailSendBudget, readEmailDeliveryState, cleanEmailSendLimits, type EmailSendBudgetConfig } from "@hyperspace-zone/control-plane";
import type { RuntimeMetrics } from "@hyperspace-zone/shared";
import { asRecord, clientIpForSecurity, clientRateLimitIdentity, readString } from "../http/request.js";
import { emailAuditHash, setAuthOutcome } from "../http/auth-audit.js";
import { WindowLimiter } from "../http/window-limiter.js";

export interface TurnstileConfig { enabled: boolean; siteKey: string; secretKey: string; hostnames: string[]; timeoutMs: number }
export interface EmailAuthProtectionConfig { turnstile: TurnstileConfig; budget: EmailSendBudgetConfig; otpIpMax: number; otpIpWindowSeconds: number }
export type TurnstileResult = "verified" | "rejected" | "unavailable";
export async function verifyTurnstile(config: TurnstileConfig, token: string, ip: string, action: string, http: typeof fetch = fetch): Promise<TurnstileResult> {
  if (!config.enabled) return "verified";
  if (!token || token.length > 2048) return "rejected";
  try {
    const response = await http("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(config.timeoutMs),
      body: JSON.stringify({ secret: config.secretKey, response: token, remoteip: ip })
    });
    if (!response.ok) { await response.body?.cancel(); return "unavailable"; }
    const result = await response.json() as { success?: boolean; hostname?: string; action?: string; "error-codes"?: string[] };
    if (result["error-codes"]?.some(code => ["missing-input-secret", "invalid-input-secret", "internal-error"].includes(code))) return "unavailable";
    return result.success === true && config.hostnames.includes(result.hostname ?? "") && result.action === action ? "verified" : "rejected";
  } catch { return "unavailable"; }
}

export function createEmailAuthProtection(app: FastifyInstance, db: Database, config: EmailAuthProtectionConfig, hashSecret: string, metrics?: RuntimeMetrics): {
  admit: (request: FastifyRequest, reply: FastifyReply, action: "email_otp" | "register") => Promise<boolean>;
} {
  const limits = new WindowLimiter();
  let verifying = 0, refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const budget = await readEmailSendBudget(db);
      const delivery = await readEmailDeliveryState(db);
      metrics?.gauge("email_auth_delivery_unavailable", delivery.failed ? 1 : 0);
      metrics?.gauge("email_auth_budget_used", budget.used);
      metrics?.gauge("email_auth_budget_limit", config.budget.dailyMax);
      metrics?.gauge("email_auth_budget_remaining", Math.max(0, config.budget.dailyMax - budget.used));
      metrics?.gauge("email_auth_provider_backoff_until_seconds", budget.blockedUntil / 1000);
      metrics?.gauge("email_auth_budget_snapshot_timestamp_seconds", Date.now() / 1000);
      metrics?.gauge("email_auth_limiter_unavailable", 0);
      await cleanEmailSendLimits(db);
    } catch { metrics?.gauge("email_auth_limiter_unavailable", 1); app.log.warn({ event: "email_auth_budget_refresh_failed" }); }
    finally { refreshing = false; }
  };
  const timer = setInterval(() => void refresh(), 60_000); timer.unref();
  app.addHook("onReady", refresh);
  app.addHook("onClose", async () => { clearInterval(timer); });
  metrics?.gauge("turnstile_required", config.turnstile.enabled ? 1 : 0);
  metrics?.gauge("turnstile_verification_unavailable", 0);
  metrics?.gauge("email_auth_limiter_unavailable", 0);
  metrics?.gauge("email_auth_budget_snapshot_timestamp_seconds", 0);
  const reject = (request: FastifyRequest, reply: FastifyReply, reason: string, status: number, retryAfter?: number): false => {
    setAuthOutcome(request, reason);
    metrics?.counter("email_auth_rejections_total", 1, { labels: { reason } });
    reply.header("cache-control", "no-store");
    if (retryAfter) reply.header("retry-after", String(retryAfter));
    reply.code(status).send({ error: status === 429 ? "rate_limited" : reason,
      message: status === 429 ? `Too many code requests. Retry after ${retryAfter ?? 60} seconds.` : reason === "turnstile_rejected" ? "Please complete the security check and try again." : "Email sign-in is temporarily unavailable. Try again later or use Google." });
    return false;
  };
  return {
    async admit(request, reply, action) {
      const counter = limits.consume(clientRateLimitIdentity(request), config.otpIpMax, config.otpIpWindowSeconds * 1000);
      if (!counter.allowed) return reject(request, reply, "otp_ip_limit", 429, Math.max(1, Math.ceil((counter.resetAt - Date.now()) / 1000)));
      if (verifying >= 8) return reject(request, reply, "verification_busy", 503, 2);
      const body = asRecord(request.body);
      verifying++;
      let verification: TurnstileResult;
      try { verification = await verifyTurnstile(config.turnstile, readString(body, "turnstileToken"), clientIpForSecurity(request), action); }
      finally { verifying--; }
      if (verification === "unavailable") {
        metrics?.gauge("turnstile_verification_unavailable", 1);
        return reject(request, reply, "turnstile_unavailable", 503, 10);
      }
      if (verification !== "verified") return reject(request, reply, "turnstile_rejected", 403);
      metrics?.gauge("turnstile_verification_unavailable", 0);
      try {
        const reservation = await reserveEmailSend(db, emailAuditHash(readString(body, "email"), hashSecret), config.budget);
        if (!reservation.allowed) {
          if (reservation.reason === "daily_budget") { metrics?.gauge("email_auth_budget_remaining", 0); metrics?.gauge("email_auth_budget_used", config.budget.dailyMax); }
          return reject(request, reply, reservation.reason, ["daily_budget", "provider_backoff"].includes(reservation.reason) ? 503 : 429, reservation.retryAfter);
        }
        metrics?.counter("email_auth_send_reservations_total", 1);
        metrics?.gauge("email_auth_limiter_unavailable", 0);
        return true;
      } catch { metrics?.gauge("email_auth_limiter_unavailable", 1); return reject(request, reply, "email_limiter_unavailable", 503, 10); }
    }
  };
}
