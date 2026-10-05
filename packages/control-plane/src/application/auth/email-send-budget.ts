import type { TransactionalQueryable, Queryable } from "../../db/queryable.js";

export interface EmailSendBudgetConfig { dailyMax: number; intervalMs: number; emailWindowSeconds: number; emailMax: number; cooldownSeconds: number }
export const defaultEmailSendBudgetConfig: EmailSendBudgetConfig = { dailyMax: 80, intervalMs: 1000, emailWindowSeconds: 900, emailMax: 3, cooldownSeconds: 60 };
interface LimitRow { key: string; windowStart: string; sendCount: number; lastAttemptAt: string; blockedUntil: string | null }
export type EmailSendReservation = { allowed: true } | { allowed: false; reason: "daily_budget" | "send_pacing" | "email_cooldown" | "email_limit" | "provider_backoff"; retryAfter: number };

export async function reserveEmailSend(db: TransactionalQueryable, emailHash: string, config: EmailSendBudgetConfig): Promise<EmailSendReservation> {
  return db.transaction(async client => {
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    await client.query("SET LOCAL statement_timeout = '2000ms'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('hyperspace-email-send-budget:' || current_schema()))");
    const now = Date.now(), day = Math.floor(now / 86_400_000) * 86_400_000;
    const rows = await client.query<LimitRow>(`SELECT key, window_start::text AS "windowStart", send_count AS "sendCount", last_attempt_at::text AS "lastAttemptAt", blocked_until::text AS "blockedUntil"
      FROM email_auth_send_limits WHERE key = ANY($1::text[]) FOR UPDATE`, [["global", `email:${emailHash}`]]);
    const global = rows.rows.find(row => row.key === "global"), recipient = rows.rows.find(row => row.key !== "global");
    const reject = (reason: Exclude<EmailSendReservation, { allowed: true }>["reason"], until: number): EmailSendReservation => ({ allowed: false, reason, retryAfter: Math.max(1, Math.ceil((until - now) / 1000)) });
    if (global?.blockedUntil && Date.parse(global.blockedUntil) > now) return reject("provider_backoff", Date.parse(global.blockedUntil));
    if (global && Date.parse(global.windowStart) === day && global.sendCount >= config.dailyMax) return reject("daily_budget", day + 86_400_000);
    if (global && Date.parse(global.lastAttemptAt) + config.intervalMs > now) return reject("send_pacing", Date.parse(global.lastAttemptAt) + config.intervalMs);
    if (recipient && Date.parse(recipient.lastAttemptAt) + config.cooldownSeconds * 1000 > now) return reject("email_cooldown", Date.parse(recipient.lastAttemptAt) + config.cooldownSeconds * 1000);
    const recipientActive = recipient && Date.parse(recipient.windowStart) + config.emailWindowSeconds * 1000 > now;
    const windowStart = recipientActive ? Date.parse(recipient.windowStart) : now;
    if (recipientActive && recipient.sendCount >= config.emailMax) return reject("email_limit", windowStart + config.emailWindowSeconds * 1000);
    for (const [key, start] of [["global", day], [`email:${emailHash}`, windowStart]] as const) {
      await client.query(`INSERT INTO email_auth_send_limits(key, window_start, send_count, last_attempt_at) VALUES($1, $2::timestamptz, 1, $3::timestamptz)
        ON CONFLICT(key) DO UPDATE SET window_start = EXCLUDED.window_start, last_attempt_at = EXCLUDED.last_attempt_at,
          send_count = CASE WHEN email_auth_send_limits.window_start = EXCLUDED.window_start THEN email_auth_send_limits.send_count + 1 ELSE 1 END`,
      [key, new Date(start).toISOString(), new Date(now).toISOString()]);
    }
    return { allowed: true };
  });
}

export async function pauseEmailSending(db: Queryable, seconds: number): Promise<void> {
  await db.query("UPDATE email_auth_send_limits SET blocked_until = GREATEST(COALESCE(blocked_until, now()), now() + $1 * interval '1 second') WHERE key = 'global'", [seconds]);
}

export async function recordEmailDeliveryState(db: Queryable, status: "sent" | "failed", providerError: string | null): Promise<void> {
  await db.query("UPDATE email_auth_send_limits SET last_delivery_status = $1, last_provider_error = $2, last_delivery_at = now() WHERE key = 'global'", [status, providerError]);
}
export async function readEmailDeliveryState(db: Queryable): Promise<{ failed: boolean }> {
  const result = await db.query<{ status: string }>("SELECT last_delivery_status AS status FROM email_auth_send_limits WHERE key = 'global'");
  return { failed: result.rows[0]?.status === "failed" };
}

export async function readEmailSendBudget(db: Queryable): Promise<{ used: number; blockedUntil: number }> {
  const result = await db.query<LimitRow>(`SELECT window_start::text AS "windowStart", send_count AS "sendCount", blocked_until::text AS "blockedUntil" FROM email_auth_send_limits WHERE key = 'global'`);
  const row = result.rows[0], day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  return { used: row && Date.parse(row.windowStart) === day ? row.sendCount : 0, blockedUntil: row?.blockedUntil ? Date.parse(row.blockedUntil) : 0 };
}

export async function cleanEmailSendLimits(db: Queryable): Promise<void> {
  await db.query(`DELETE FROM email_auth_send_limits WHERE key IN
    (SELECT key FROM email_auth_send_limits WHERE key <> 'global' AND last_attempt_at < now() - interval '2 days' LIMIT 500)`);
}
