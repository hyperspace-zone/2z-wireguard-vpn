import type { Queryable, TransactionalQueryable } from "../../db/queryable.js";
import {
  consumeEmailLoginChallenge,
  findLatestEmailLoginChallengeForUpdate,
  findPublicUserByEmail,
  incrementEmailLoginChallengeAttempts,
  insertEmailLoginChallenge,
  insertUserWithoutPassword,
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
  }): Promise<void>;
}

export interface RequestEmailLoginCodeInput {
  email: string;
  codeTtlSeconds: number;
  hashSecret: string;
  sender: EmailSender;
  exposeCode?: boolean;
}

export type RequestEmailLoginCodeResult =
  | {
    status: "sent";
    email: string;
    expiresAt: string;
    devCode?: string;
  }
  | "invalid_email";

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
  const expiresAt = new Date(Date.now() + input.codeTtlSeconds * 1000).toISOString();
  const codeHash = hashEmailOtp(input.hashSecret, email, code);
  const challenge = await insertEmailLoginChallenge(db, {
    email,
    codeHash,
    expiresAt,
    metadata: { flow: "self-service-email-login" }
  });

  await input.sender.sendLoginCode({ email, code, expiresAt: challenge.expiresAt });

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
