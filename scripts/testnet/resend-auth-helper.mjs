export function createResendAuthHelper(input) {
  const resendApiKey = input.resendApiKey || process.env.RESEND_RECEIVING_API_KEY || process.env.RESEND_API_KEY || "";
  const timeoutMs = Number(input.timeoutMs || process.env.RESEND_RECEIVING_TIMEOUT_MS || 90_000);
  const seenEmailIds = new Set();

  return {
    async registerPassword({ email, password, displayName }) {
      const registration = await input.api("/v1/public/auth/register", {
        method: "POST",
        body: { email, password, ...(displayName ? { displayName } : {}) },
        expectedStatus: 201
      });
      const code = registration.devCode || await waitForOtp(email);
      return verifyOtp(email, code);
    },

    async loginWithOtp(email) {
      const challenge = await input.api("/v1/public/auth/email/request-code", {
        method: "POST",
        body: { email }
      });
      const code = challenge.devCode || await waitForOtp(email);
      return verifyOtp(email, code);
    },

    waitForOtp
  };

  async function verifyOtp(email, code) {
    return input.api("/v1/public/auth/email/verify-code", {
      method: "POST",
      body: { email, code }
    });
  }

  async function waitForOtp(recipient) {
    if (!resendApiKey) {
      throw new Error("RESEND_RECEIVING_API_KEY with Full access is required when the API does not expose test OTP codes");
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const list = await resend("/emails/receiving");
      const email = (list.data || []).find((candidate) =>
        !seenEmailIds.has(candidate.id) &&
        Array.isArray(candidate.to) &&
        candidate.to.some((address) => address.toLowerCase() === recipient.toLowerCase()) &&
        candidate.subject === "Your Hyperspace sign-in code"
      );
      if (email) {
        seenEmailIds.add(email.id);
        const content = await resend(`/emails/receiving/${encodeURIComponent(email.id)}`);
        const match = String(content.text || "").match(/sign-in code is\s+(\d{6})/i);
        if (!match) {
          throw new Error(`OTP was not found in received email ${email.id}`);
        }
        return match[1];
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Timed out waiting for OTP sent to ${recipient}`);
  }

  async function resend(path) {
    const response = await fetch(`https://api.resend.com${path}`, {
      headers: { authorization: `Bearer ${resendApiKey}` }
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`Resend ${path} returned ${response.status}: ${payload.message || payload.name || "request failed"}`);
    }
    return payload;
  }
}

export function uniqueResendAddress(prefix, domain = process.env.RESEND_RECEIVING_DOMAIN || "vutcenoi.resend.app") {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}@${domain}`;
}
