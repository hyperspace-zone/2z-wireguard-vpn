import assert from "node:assert/strict";
import test from "node:test";
import { emailCodeView } from "./email-code-view.js";

const initial = { email: "unit@example.com", codeSent: false, busy: false, notice: "", noticeIsError: false };

test("initial requests and failed sends show CAPTCHA, not code verification", () => {
  for (const notice of ["", "Retry after 60 seconds."]) {
    const html = emailCodeView({ ...initial, notice, noticeIsError: !!notice });
    assert.match(html, /id="auth-security-check" data-action="email_otp"/);
    assert.match(html, /id="email-code-request-form"/);
    assert.doesNotMatch(html, /id="email-code-verify-form"/);
    if (notice) assert.match(html, /role="alert"/);
  }
});

test("successful email delivery goes directly to verification without a second CAPTCHA", () => {
  const html = emailCodeView({ ...initial, codeSent: true, notice: "Email code sent." });
  assert.match(html, /id="email-code-verify-form"/);
  assert.match(html, /autocomplete="one-time-code"/);
  assert.match(html, /unit@example.com/);
  assert.match(html, /role="status"/);
  assert.match(html, /id="email-code-resend"/);
  assert.match(html, /id="email-code-change-email"/);
  assert.doesNotMatch(html, /auth-security-check|email-code-request-form/);
});

test("checking and retrying a code never renders a CAPTCHA; busy actions are disabled", () => {
  for (const busy of [true, false]) {
    const html = emailCodeView({ ...initial, codeSent: true, busy, notice: "Invalid verification code.", noticeIsError: true });
    assert.doesNotMatch(html, /auth-security-check|email-code-request-form/);
    assert.match(html, /id="email-code-verify-form"/);
    assert.match(html, /role="alert"/);
    assert.equal((html.match(/ disabled/g) ?? []).length, busy ? 3 : 0);
  }
});

test("explicit resend retains the email and returns to CAPTCHA; change email clears it", () => {
  for (const email of [initial.email, ""]) {
    const html = emailCodeView({ ...initial, email });
    assert.match(html, /id="auth-security-check"/);
    assert.ok(html.includes(`value="${email}"`));
    assert.doesNotMatch(html, /email-code-verify-form/);
  }
});

test("verification email and server notices are HTML escaped", () => {
  const html = emailCodeView({ ...initial, codeSent: true, email: '<script>"&', notice: "<img onerror='bad'>", noticeIsError: true });
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;&quot;&amp;/);
  assert.match(html, /&lt;img onerror=&#39;bad&#39;&gt;/);
});
