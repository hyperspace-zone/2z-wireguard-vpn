import { deliverNextBillingNotification, type BillingEmailSender } from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import type { ControlPlaneWorkerConfig } from "../config.js";

export function createBillingNotificationLoop(db: Database, config: ControlPlaneWorkerConfig): {
  runOnce(): Promise<"disabled" | "empty" | "sent" | "failed">;
} {
  const sender = createSender(config);
  return {
    async runOnce() {
      return sender ? deliverNextBillingNotification(db, sender) : "disabled";
    }
  };
}

function createSender(config: ControlPlaneWorkerConfig): BillingEmailSender | null {
  if (config.billingNotifications.provider !== "resend" || !config.billingNotifications.resendApiKey) {
    return null;
  }
  return {
    async send(input) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.billingNotifications.resendApiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          from: config.billingNotifications.from,
          to: [input.to],
          reply_to: config.billingNotifications.replyTo,
          subject: input.subject,
          text: input.text,
          html: input.html
        })
      });
      if (!response.ok) {
        throw new Error(`resend_delivery_failed:${response.status}:${(await response.text()).slice(0, 200)}`);
      }
    }
  };
}
