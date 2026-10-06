#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { chromium } from "playwright-core";

// Browser integration with a fake external widget and local API. No live OTPs/emails.
const root = resolve(new URL("../..", import.meta.url).pathname);
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const file = join(root, "apps/web/dist", path === "/" || !extname(path) ? "index.html" : path);
  try { const data = await readFile(file); response.writeHead(200, { "content-type": extname(file) === ".js" ? "text/javascript" : extname(file) === ".css" ? "text/css" : "text/html" }); response.end(data); }
  catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/snap/bin/chromium", args: ["--no-sandbox"] });
try {
  const page = await browser.newPage(); let sent = 0, registered = 0, verified = 0;
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js*", route => route.fulfill({ contentType: "text/javascript", body: `
    window.turnstile={render(el,opts){window.widgetRenders=(window.widgetRenders||0)+1;window.widgetOptions=opts;el.innerHTML='<button type="button" id="complete-check">Complete check</button>';el.querySelector('button').onclick=()=>opts.callback('unit-token-'+opts.action);return 'unit-widget'},remove(){}};` }));
  await page.route("**/api/v1/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/auth/security")) return json({ turnstileEnabled: true, turnstileSiteKey: "unit-site" });
    if (path.endsWith("/auth/me")) return json({ error: "auth_required" }, 401);
    if (path.endsWith("/gates")) return json({ gates: [] });
    if (path.endsWith("/auth/email/request-code")) {
      sent++;
      assert.equal(req.postDataJSON().turnstileToken, "unit-token-email_otp");
      if (sent === 1) return json({ error: "rate_limited", message: "Retry after 60 seconds." }, 429);
      return json({ status: "sent", email: req.postDataJSON().email });
    }
    if (path.endsWith("/auth/email/verify-code")) {
      verified++;
      assert.deepEqual(req.postDataJSON(), { email: "unit@example.com", code: "123456" });
      return json({ error: "invalid_code", message: "Invalid verification code." }, 401);
    }
    if (path.endsWith("/auth/register")) { registered++; assert.equal(req.postDataJSON().turnstileToken, "unit-token-register"); return json({ status: "sent", email: req.postDataJSON().email, expiresAt: new Date(Date.now() + 600_000).toISOString() }, 201); }
    return json({});
  });
  await page.goto(`${base}/login`);
  const send = page.locator('#email-code-request-form button[type="submit"]');
  await page.locator("#complete-check").waitFor(); assert.equal(await send.isDisabled(), true);
  await page.locator('#email-code-request-form input[name="email"]').fill("unit@example.com");
  await page.locator("#complete-check").click(); assert.equal(await send.isEnabled(), true);
  await send.click(); await page.locator("#complete-check").waitFor();
  assert.equal(sent, 1); assert.equal(await send.isDisabled(), true, "Rejected requests require a fresh single-use token");
  assert.equal(await page.locator("#auth-notice").innerText(), "Retry after 60 seconds.");
  assert.equal(await page.locator("#auth-notice").getAttribute("role"), "alert");
  assert.equal(await page.locator("#google-login").isEnabled(), true);
  assert.equal(await page.locator("#email-code-verify-form").count(), 0, "A failed send must not enter the verification step");
  await page.locator("#complete-check").click(); await send.click();
  await page.locator("#email-code-verify-form").waitFor();
  assert.equal(sent, 2);
  assert.equal(await page.locator("#auth-security-check").count(), 0, "No CAPTCHA after a successful send");
  assert.equal(await page.locator("#email-code-request-form").count(), 0);
  const widgetRenders = await page.evaluate(() => window.widgetRenders);
  await page.locator('#email-code-verify-form input[name="code"]').fill("123456");
  await page.locator('#email-code-verify-form button[type="submit"]').click();
  await page.waitForFunction(() => document.getElementById("auth-notice")?.textContent === "Invalid verification code.");
  assert.equal(verified, 1);
  assert.equal(await page.locator("#auth-security-check").count(), 0, "Failed verification must not ask for CAPTCHA again");
  assert.equal(await page.evaluate(() => window.widgetRenders), widgetRenders);
  await page.locator("#email-code-resend").click(); await page.locator("#complete-check").waitFor();
  assert.equal(sent, 2, "Resend opens the secured request step; it does not send automatically");
  assert.equal(await send.isDisabled(), true);
  assert.equal(await page.locator('#email-code-request-form input[name="email"]').inputValue(), "unit@example.com");
  await page.locator("#complete-check").click(); await send.click();
  await page.locator("#email-code-verify-form").waitFor();
  assert.equal(sent, 3);
  assert.equal(await page.locator("#auth-security-check").count(), 0);
  await page.locator("#email-code-change-email").click(); await page.locator("#complete-check").waitFor();
  assert.equal(await page.locator('#email-code-request-form input[name="email"]').inputValue(), "");
  assert.equal(await page.locator("#email-code-verify-form").count(), 0);
  await page.goto(`${base}/register`); await page.locator("#complete-check").waitFor();
  const register = page.locator('#register-form button[type="submit"]'); assert.equal(await register.isDisabled(), true);
  await page.locator('#register-form input[name="email"]').fill("unit-register@example.com");
  await page.locator('#register-form input[name="password"]').fill("unit-password-long-enough");
  await page.locator("#complete-check").click(); await register.click();
  await page.waitForURL("**/login"); assert.equal(registered, 1);
  assert.match(await page.locator("#auth-notice").innerText(), /Account created/);
  assert.equal(await page.locator("#email-code-verify-form").count(), 1);
  assert.equal(await page.locator("#auth-security-check").count(), 0, "Registration also goes straight to code entry");
  await page.locator("#email-code-resend").click();
  await page.locator("#complete-check").waitFor();
  await page.evaluate(() => window.widgetOptions.callback("old-token"));
  assert.equal(await page.locator('#email-code-request-form button[type="submit"]').isEnabled(), true);
  await page.evaluate(() => window.widgetOptions["expired-callback"]());
  assert.equal(await page.locator('#email-code-request-form button[type="submit"]').isDisabled(), true);
  console.log("PASS: secured sends/resends, CAPTCHA-free code entry/retry, change email, registration, token expiry and Google fallback");
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
