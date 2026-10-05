import type { EmailSender } from "@hyperspace-zone/control-plane";
import type { RuntimeMetrics } from "@hyperspace-zone/shared";

export class EmailDeliveryError extends Error {
  constructor(readonly reason: "provider_rate_limit" | "provider_rejected" | "provider_unavailable", readonly retryAfter: number) { super(reason); }
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
          await response.body?.cancel(); // Do not include provider response bodies/emails in errors.
          throw new EmailDeliveryError(response.status === 429 ? "provider_rate_limit" : response.status >= 500 ? "provider_unavailable" : "provider_rejected",
            Number.isFinite(retry) && retry > 0 ? Math.min(300, Math.ceil(retry)) : response.status >= 400 && response.status < 500 && response.status !== 429 ? 300 : 30);
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
