interface EmailCodeViewState {
  email: string;
  codeSent: boolean;
  busy: boolean;
  notice: string;
  noticeIsError: boolean;
}

// CAPTCHA protects email delivery, not entry of a code already delivered.
export function emailCodeView(state: EmailCodeViewState): string {
  const { email, codeSent, busy, notice, noticeIsError } = state;
  return `
    ${!codeSent ? `
      <form id="email-code-request-form" class="auth-form">
        <label>Email <input name="email" type="email" autocomplete="email" required value="${escapeHtml(email)}" /></label>
        <div id="auth-security-check" data-action="email_otp" aria-live="polite">Loading security check…</div>
        <button type="submit" ${busy ? "disabled" : ""}>${busy ? "Sending..." : "Send code"}</button>
      </form>
    ` : `<p>Enter the code sent to <strong>${escapeHtml(email)}</strong>.</p>`}
    ${notice ? `<p id="auth-notice" class="${noticeIsError ? "bad" : "ok"}" role="${noticeIsError ? "alert" : "status"}">${escapeHtml(notice)}</p>` : ""}
    ${codeSent ? `
      <form id="email-code-verify-form" class="auth-form auth-subform">
        <label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code" minlength="6" maxlength="6" required /></label>
        <button type="submit" ${busy ? "disabled" : ""}>${busy ? "Checking..." : "Verify code"}</button>
      </form>
      <div class="auth-form">
        <button id="email-code-resend" type="button" class="secondary-button" ${busy ? "disabled" : ""}>Resend code</button>
        <button id="email-code-change-email" type="button" class="secondary-button" ${busy ? "disabled" : ""}>Change email</button>
      </div>
    ` : ""}
  `;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
