import type { EmailSender } from "@hyperspace-zone/control-plane";
import type { RuntimeMetrics } from "@hyperspace-zone/shared";

const providerCodes = ["rate_limit_exceeded", "daily_quota_exceeded", "monthly_quota_exceeded", "validation_error", "restricted_api_key", "suspended_api_key", "invalid_api_key", "application_error", "service_unavailable"] as const;
type ProviderErrorCode = typeof providerCodes[number] | "unknown";
export class EmailDeliveryError extends Error {
  constructor(readonly reason: "provider_rate_limit" | "provider_rejected" | "provider_unavailable", readonly retryAfter: number, readonly providerCode: ProviderErrorCode = "unknown") { super(reason); }
}
// Never persist an arbitrary provider body/message. Only known error names leave this parser.
async function providerErrorCode(response: Response): Promise<ProviderErrorCode> {
  const reader = response.body?.getReader(); if (!reader) return "unknown";
  let bytes = 0, text = ""; const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.length; if (bytes > 4096) { await reader.cancel(); return "unknown"; }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode(); const name = JSON.parse(text).name;
    return providerCodes.includes(name) ? name as ProviderErrorCode : "unknown";
  } catch { return "unknown"; }
  finally { reader.releaseLock(); }
}
export function createEmailSender(config: { provider: "console" | "resend"; resendApiKey: string; from: string; replyTo: string },
  metrics?: RuntimeMetrics, http: typeof fetch = fetch): EmailSender {
  let active = 0;
  metrics?.gauge("email_auth_delivery_unavailable", 0);
  return {
    async sendLoginCode(input) {
      if (config.provider === "console") return; // Only explicitly exposed devCode can reveal a development OTP.
      if (active >= 2) throw new EmailDeliveryError("provider_unavailable", 2);
      active++;
      try {
        const response = await http("https://api.resend.com/emails", {
          method: "POST", signal: AbortSignal.timeout(5000),
          headers: { authorization: `Bearer ${config.resendApiKey}`, "content-type": "application/json",
            ...(input.idempotencyKey ? { "Idempotency-Key": `email-otp/${input.idempotencyKey}` } : {}) },
          body: JSON.stringify({ from: config.from, to: [input.email], reply_to: config.replyTo, subject: "Your Hyperspace sign-in code",
            text: `Your Hyperspace sign-in code is ${input.code}.\n\nIt expires at ${input.expiresAt}.\n\nIf you did not request this code, you can ignore this email.` })
        });
        if (!response.ok) {
          const retry = Number(response.headers.get("retry-after"));
          const code = await providerErrorCode(response);
          metrics?.counter("email_auth_provider_errors_total", 1, { labels: { code, http_status: String(response.status) } });
          throw new EmailDeliveryError(response.status === 429 ? "provider_rate_limit" : response.status >= 500 ? "provider_unavailable" : "provider_rejected",
            code === "daily_quota_exceeded" || code === "monthly_quota_exceeded" ? 300 : Number.isFinite(retry) && retry > 0 ? Math.min(300, Math.ceil(retry)) : response.status >= 400 && response.status < 500 && response.status !== 429 ? 300 : 30, code);
        }
        await response.body?.cancel();
        metrics?.counter("email_auth_delivery_total", 1, { labels: { outcome: "sent" } });
        metrics?.gauge("email_auth_delivery_unavailable", 0);
      } catch (error) {
        const failure = error instanceof EmailDeliveryError ? error : new EmailDeliveryError("provider_unavailable", 30);
        metrics?.counter("email_auth_delivery_total", 1, { labels: { outcome: failure.reason } });
        metrics?.gauge("email_auth_delivery_unavailable", 1);
        throw failure;
      } finally { active--; }
    }
  };
}
