import type { TransactionalQueryable } from "../../db/queryable.js";
import {
  claimBillingNotification,
  markBillingNotificationFailed,
  markBillingNotificationSent,
  type BillingNotificationRow
} from "../../resources/billing/prepaid-repository.js";

export interface BillingEmailSender {
  send(input: { to: string; subject: string; text: string; html: string }): Promise<void>;
}

export async function deliverNextBillingNotification(
  db: TransactionalQueryable,
  sender: BillingEmailSender
): Promise<"empty" | "sent" | "failed"> {
  const notification = await db.transaction((client) => claimBillingNotification(client));
  if (!notification) return "empty";
  const message = renderBillingNotification(notification);
  try {
    await sender.send({ to: notification.recipientEmail, ...message });
    await markBillingNotificationSent(db, notification.id);
    return "sent";
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    const retrySeconds = Math.min(3600, 15 * (2 ** Math.min(notification.attemptCount, 8)));
    await markBillingNotificationFailed(db, notification.id, messageText, retrySeconds);
    return "failed";
  }
}

export function renderBillingNotification(
  notification: BillingNotificationRow
): { subject: string; text: string; html: string } {
  const payload = notification.payload;
  const balance = formatMoney(readNumber(payload.balanceMinor));
  const dueAt = readString(payload.suspensionDueAt);
  const eligibleAt = readString(payload.withdrawalEligibleAt) || readString(payload.eligibleAt);
  const configs = readConfigs(payload.configs);
  const configText = configs.length > 0
    ? `\nAffected configs:\n${configs.map((config) => `- ${config.label || config.id}`).join("\n")}`
    : "";
  let subject = "Hyperspace billing update";
  let body = "Your Hyperspace billing account was updated.";
  if (notification.notificationType === "billing_grace_started") {
    subject = "Action required: Hyperspace balance exhausted";
    body = `Your available balance is ${balance}. Active VPN configs are in a grace period and are scheduled to be disabled at ${dueAt || "the configured deadline"}. Top up before that time to keep them active.${configText}`;
  } else if (notification.notificationType === "billing_configs_suspended") {
    subject = "Hyperspace VPN configs disabled";
    body = `Your VPN configs were disabled because the prepaid balance remains ${balance}. They will not reactivate automatically after a top-up.${configText}`;
  } else if (notification.notificationType === "billing_balance_restored") {
    subject = "Hyperspace balance restored";
    body = `Your available balance is now ${balance}. Any configs already disabled for billing remain disabled; create or enable a config explicitly.`;
  } else if (notification.notificationType === "billing_withdrawal_requested") {
    subject = "Hyperspace withdrawal cooldown started";
    body = `Your withdrawal request is recorded. It becomes eligible after ${eligibleAt || "the configured cooldown"}, provided every VPN config remains disabled.`;
  } else if (notification.notificationType === "billing_withdrawal_confirmed") {
    subject = "Hyperspace withdrawal completed";
    body = `Your unused paid balance was sent. Solana transaction: ${readString(payload.transactionSignature)}`;
  }
  const footer = "\n\nQuestions or test-credit requests: gatekeepers@hyperspace.zone";
  const text = body + footer;
  return {
    subject,
    text,
    html: `<p>${escapeHtml(body).replace(/\n/g, "<br>")}</p><p>Questions or test-credit requests: <a href="mailto:gatekeepers@hyperspace.zone">gatekeepers@hyperspace.zone</a></p>`
  };
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readConfigs(value: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return { id: readString(row.id), label: readString(row.label) };
  }).filter((item) => item.id || item.label);
}

function formatMoney(minor: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(minor / 100);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character] ?? character));
}
