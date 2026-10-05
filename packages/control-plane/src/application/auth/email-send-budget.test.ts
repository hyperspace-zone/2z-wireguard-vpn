import assert from "node:assert/strict";
import test from "node:test";
import type { TransactionalQueryable } from "../../db/queryable.js";
import { reserveEmailSend, defaultEmailSendBudgetConfig } from "./email-send-budget.js";
function fixture() {
  const rows = new Map<string, { key: string; windowStart: string; sendCount: number; lastAttemptAt: string; blockedUntil: string | null }>();
  const db: TransactionalQueryable = {
    transaction: async fn => fn(db),
    async query<Row extends object>(sql: string, params: readonly unknown[] = []): Promise<{ rows: Row[] }> {
      if (sql.includes("SELECT key,")) return { rows: (params[0] as string[]).map(key => rows.get(key)).filter(Boolean) as Row[] };
      if (sql.includes("INSERT INTO email_auth_send_limits")) {
        const key = params[0] as string, start = params[1] as string, existing = rows.get(key);
        rows.set(key, { key, windowStart: start, lastAttemptAt: params[2] as string, sendCount: existing?.windowStart === start ? existing.sendCount + 1 : 1, blockedUntil: existing?.blockedUntil ?? null });
      }
      return { rows: [] };
    }
  }; return { db, rows };
}
test("cooldown and recipient window cannot be reset by another request", t => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-05T12:00:00Z"));
  return (async () => {
    const { db } = fixture(), config = { ...defaultEmailSendBudgetConfig, intervalMs: 0 };
    assert.equal((await reserveEmailSend(db, "email-hash", config)).allowed, true);
    const result = await reserveEmailSend(db, "email-hash", config);
    assert.deepEqual(result, { allowed: false, reason: "email_cooldown", retryAfter: 60 });
  })();
});
test("same-millisecond calls still enforce recipient cap", async t => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-05T12:00:00Z"));
  const { db, rows } = fixture(), config = { ...defaultEmailSendBudgetConfig, intervalMs: 0, cooldownSeconds: 0 };
  for (let i = 0; i < 3; i++) assert.equal((await reserveEmailSend(db, "email-hash", config)).allowed, true);
  assert.deepEqual(await reserveEmailSend(db, "email-hash", config), { allowed: false, reason: "email_limit", retryAfter: 900 });
  assert.equal(rows.get("global")?.sendCount, 3);
});
test("global UTC budget and provider backoff reject before creating new recipient state", async t => {
  const now = Date.parse("2026-10-05T12:00:00Z"); t.mock.method(Date, "now", () => now);
  const { db, rows } = fixture(), config = { ...defaultEmailSendBudgetConfig, dailyMax: 1, intervalMs: 0 };
  assert.equal((await reserveEmailSend(db, "a", config)).allowed, true);
  assert.deepEqual(await reserveEmailSend(db, "b", config), { allowed: false, reason: "daily_budget", retryAfter: 43200 });
  assert.equal(rows.size, 2);
  rows.get("global")!.blockedUntil = new Date(now + 30_000).toISOString();
  assert.deepEqual(await reserveEmailSend(db, "b", config), { allowed: false, reason: "provider_backoff", retryAfter: 30 });
});
test("global pacing rejects distributed recipients and expires without a queue", async t => {
  let now = Date.parse("2026-10-05T12:00:00Z"); t.mock.method(Date, "now", () => now);
  const { db } = fixture(); assert.equal((await reserveEmailSend(db, "a", defaultEmailSendBudgetConfig)).allowed, true);
  assert.deepEqual(await reserveEmailSend(db, "b", defaultEmailSendBudgetConfig), { allowed: false, reason: "send_pacing", retryAfter: 1 });
  now += 1000; assert.equal((await reserveEmailSend(db, "b", defaultEmailSendBudgetConfig)).allowed, true);
});
