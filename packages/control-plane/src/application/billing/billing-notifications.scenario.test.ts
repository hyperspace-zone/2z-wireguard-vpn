import assert from "node:assert/strict";
import test from "node:test";
import { renderBillingNotification } from "./billing-notifications.scenario.js";

test("grace email names affected configs, deadline, support address, and escapes labels", () => {
  const message = renderBillingNotification({
    id: "notification-1",
    accountId: "account-1",
    notificationType: "billing_grace_started",
    recipientEmail: "billing-alert-unit@vutcenoi.resend.app",
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

test("traffic quota email explains the hard limit without debt", () => {
  const message = renderBillingNotification({
    id: "notification-2",
    accountId: "account-2",
    notificationType: "traffic_quota_exhausted",
    recipientEmail: "traffic-alert-unit@vutcenoi.resend.app",
    payload: {
      includedBytes: "50000000000",
      consumedBytes: "50000000042",
      configs: [{ id: "session-2", label: "primary route" }]
    },
    attemptCount: 0
  });

  assert.match(message.subject, /traffic limit reached/i);
  assert.match(message.text, /50 GB/);
  assert.match(message.text, /disabled/);
  assert.match(message.text, /No debt or overage charge/);
  assert.match(message.text, /primary route/);
});
