import type { Queryable, TransactionalQueryable } from "../../db/queryable.js";
import {
  consumeEmailLoginChallenge,
  findLatestEmailLoginChallengeForUpdate,
  findPublicUserByEmail,
  incrementEmailLoginChallengeAttempts,
  insertEmailLoginChallenge,
  insertUserWithoutPassword,
  lockIdentityEmail,
  upsertIdentity,
  type PublicUser
} from "../../resources/users/repository.js";
import { isUniqueViolation } from "../../support/db.js";
import { createAuthSession } from "./auth-session.js";
import { generateNumericOtp, hashEmailOtp, verifyHash } from "./otp.js";
import type { AuthSessionResult } from "./register-user.scenario.js";

export interface EmailSender {
  sendLoginCode(input: {
    email: string;
    code: string;
    expiresAt: string;
    idempotencyKey?: string;
  }): Promise<void>;
}

export interface RequestEmailLoginCodeInput {
  email: string;
  codeTtlSeconds: number;
  hashSecret: string;
  sender: EmailSender;
  exposeCode?: boolean;
  requestInfo?: { sourceIp: string; requestId: string; turnstileVerified: boolean };
}

export type RequestEmailLoginCodeResult =
  | {
    status: "sent";
    email: string;
    expiresAt: string;
    devCode?: string;
  }
  | "invalid_email"
  | "too_many_attempts";

export interface VerifyEmailLoginCodeInput {
  email: string;
  code: string;
  hashSecret: string;
  authSessionTtlSeconds: number;
  maxAttempts?: number;
}

export type VerifyEmailLoginCodeResult =
  | AuthSessionResult
  | "invalid_email"
  | "invalid_code"
  | "code_expired"
  | "too_many_attempts";

export async function requestEmailLoginCode(
  db: TransactionalQueryable,
  input: RequestEmailLoginCodeInput
): Promise<RequestEmailLoginCodeResult> {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) {
    return "invalid_email";
  }

  const code = generateNumericOtp();
  const codeHash = hashEmailOtp(input.hashSecret, email, code);
  const challenge = await db.transaction(async client => {
    await lockIdentityEmail(client, email);
    const previous = await findLatestEmailLoginChallengeForUpdate(client, email);
    const active = previous && Date.parse(previous.expiresAt) > Date.now() ? previous : null;
    if (active && active.attemptCount >= 5) return "too_many_attempts" as const;
    // Resending must not reset the guess counter or extend the guessing window.
    return insertEmailLoginChallenge(client, {
      email, codeHash, attemptCount: active?.attemptCount ?? 0,
      expiresAt: active ? new Date(active.expiresAt).toISOString() : new Date(Date.now() + input.codeTtlSeconds * 1000).toISOString(),
      metadata: { flow: "self-service-email-login", delivery_status: "pending", ...(input.requestInfo ? {
        source_ip: input.requestInfo.sourceIp, request_id: input.requestInfo.requestId, turnstile_verified: input.requestInfo.turnstileVerified
      } : {}) }
    });
  });
  if (challenge === "too_many_attempts") return challenge;
  try {
    await input.sender.sendLoginCode({ email, code, expiresAt: challenge.expiresAt, idempotencyKey: challenge.id });
    await db.query("UPDATE email_login_challenges SET metadata = metadata || '{\"delivery_status\":\"sent\"}'::jsonb WHERE id = $1", [challenge.id]);
  } catch (error) {
    // Preserve evidence but make an undelivered OTP unusable. Do not invalidate an earlier working code.
    await db.transaction(async client => {
      await lockIdentityEmail(client, email);
      const attempts = await client.query<{ count: number }>("UPDATE email_login_challenges SET consumed_at = now(), metadata = metadata || '{\"delivery_status\":\"failed\"}'::jsonb WHERE id = $1 RETURNING attempt_count AS count", [challenge.id]);
      const previous = await findLatestEmailLoginChallengeForUpdate(client, email);
      if (previous && (attempts.rows[0]?.count ?? 0) > previous.attemptCount) {
        await client.query("UPDATE email_login_challenges SET attempt_count = GREATEST(attempt_count, $2) WHERE id = $1", [previous.id, attempts.rows[0]!.count]);
      }
    });
    throw error;
  }

  return {
    status: "sent",
    email,
    expiresAt: challenge.expiresAt,
    ...(input.exposeCode ? { devCode: code } : {})
  };
}

export async function verifyEmailLoginCode(
  db: TransactionalQueryable,
  input: VerifyEmailLoginCodeInput
): Promise<VerifyEmailLoginCodeResult> {
  const email = normalizeEmail(input.email);
  const code = input.code.trim();
  if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
    return "invalid_code";
  }
  const maxAttempts = input.maxAttempts ?? 5;

  return db.transaction(async (client) => {
    await lockIdentityEmail(client, email);
    const challenge = await findLatestEmailLoginChallengeForUpdate(client, email);
    if (!challenge) {
      return "invalid_code";
    }
    if (challenge.attemptCount >= maxAttempts) {
      return "too_many_attempts";
    }
    if (Date.parse(challenge.expiresAt) <= Date.now()) {
      return "code_expired";
    }

    const codeHash = hashEmailOtp(input.hashSecret, email, code);
    if (!verifyHash(codeHash, challenge.codeHash)) {
      await incrementEmailLoginChallengeAttempts(client, challenge.id);
      return "invalid_code";
    }

    await consumeEmailLoginChallenge(client, challenge.id);
    // Consume other valid codes from this window to prevent fallback/replay after success.
    await client.query(`UPDATE email_login_challenges SET consumed_at = now() WHERE email = $1 AND consumed_at IS NULL
      AND created_at >= now() - interval '30 minutes' AND expires_at > now()`, [email]);
    const user = await findOrCreateEmailUser(client, email);
    await upsertIdentity(client, {
      accountId: user.accountId,
      provider: "email",
      providerSubject: email,
      email,
      metadata: { login: "otp" },
      verifiedAt: new Date().toISOString()
    });
    const session = await createAuthSession(user.id, input.authSessionTtlSeconds, client);
    return { user, accessToken: session.token, expiresAt: session.expiresAt };
  });
}

async function findOrCreateEmailUser(db: Queryable, email: string): Promise<PublicUser> {
  const existing = await findPublicUserByEmail(db, email);
  if (existing) {
    return existing;
  }

  try {
    return await insertUserWithoutPassword(db, {
      email,
      displayName: email
    });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const raced = await findPublicUserByEmail(db, email);
    if (!raced) {
      throw error;
    }
    return raced;
  }
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isValidEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
