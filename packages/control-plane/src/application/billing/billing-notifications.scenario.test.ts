import assert from "node:assert/strict";
import test from "node:test";
import { renderBillingNotification } from "./billing-notifications.scenario.js";

test("grace email names affected configs, deadline, support address, and escapes labels", () => {
  const message = renderBillingNotification({
    id: "notification-1",
    accountId: "account-1",
    notificationType: "billing_grace_started",
    recipientEmail: "billing-alert-unit@ostealmar.resend.app",
    attemptCount: 1,
    payload: {
      balanceMinor: -125,
      suspensionDueAt: "2026-07-16T12:00:00.000Z",
      configs: [{ id: "session-1", label: "London <prod>" }]
    }
  });

  assert.match(message.subject, /Action required/);
  assert.match(message.text, /London <prod>/);
  assert.match(message.text, /2026-07-16T12:00:00.000Z/);
  assert.match(message.text, /gatekeepers@hyperspace.zone/);
  assert.doesNotMatch(message.html, /London <prod>/);
  assert.match(message.html, /London &lt;prod&gt;/);
});
