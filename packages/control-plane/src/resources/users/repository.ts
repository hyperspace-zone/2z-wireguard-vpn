import type { Queryable } from "../../db/queryable.js";
import { mustRow } from "../../support/db.js";

export interface PublicUser {
  id: string;
  accountId: string;
  email: string;
  displayName: string;
}

export interface PasswordCredentialRow extends PublicUser {
  passwordHash: string;
}

export async function insertRegisteredUser(
  db: Queryable,
  input: {
    email: string;
    displayName: string;
    passwordHash: string;
  }
): Promise<PublicUser> {
  const account = await db.query<{ id: string }>(
    "INSERT INTO accounts (display_name) VALUES ($1) RETURNING id",
    [input.displayName]
  );
  const accountId = mustRow(account).id;
  const user = await db.query<PublicUser>(
    `
      INSERT INTO users (account_id, email, display_name)
      VALUES ($1, $2, $3)
      RETURNING id, account_id AS "accountId", email::text, display_name AS "displayName"
    `,
    [accountId, input.email, input.displayName]
  );
  const createdUser = mustRow(user);

  await db.query(
    "INSERT INTO password_credentials (user_id, password_hash) VALUES ($1, $2)",
    [createdUser.id, input.passwordHash]
  );
  await db.query(
    `
      INSERT INTO audit_events (event_type, actor_type, actor_id, account_id, details)
      VALUES ('user_registered', 'user', $1, $2, $3::jsonb)
    `,
    [createdUser.id, createdUser.accountId, JSON.stringify({ email: createdUser.email })]
  );

  return createdUser;
}

export async function findPasswordCredentialByEmail(
  db: Queryable,
  email: string
): Promise<PasswordCredentialRow | null> {
  const credential = await db.query<PasswordCredentialRow>(
    `
      SELECT
        users.id,
        users.account_id AS "accountId",
        users.email::text,
        users.display_name AS "displayName",
        password_credentials.password_hash AS "passwordHash"
      FROM users
      JOIN password_credentials ON password_credentials.user_id = users.id
      WHERE users.email = $1 AND users.disabled_at IS NULL
    `,
    [email]
  );
  return credential.rows[0] ?? null;
}

export async function insertAuthSession(
  db: Queryable,
  input: {
    userId: string;
    tokenHash: string;
    expiresAt: string;
  }
): Promise<void> {
  await db.query(
    `
      INSERT INTO auth_sessions (user_id, token_hash, expires_at)
      VALUES ($1, $2, $3::timestamptz)
    `,
    [input.userId, input.tokenHash, input.expiresAt]
  );
}

export async function findActiveAuthSessionUserByTokenHash(
  db: Queryable,
  tokenHash: string
): Promise<PublicUser | null> {
  const result = await db.query<PublicUser>(
    `
      SELECT
        users.id,
        users.account_id AS "accountId",
        users.email::text,
        users.display_name AS "displayName"
      FROM auth_sessions
      JOIN users ON users.id = auth_sessions.user_id
      WHERE auth_sessions.token_hash = $1
        AND auth_sessions.expires_at > now()
        AND auth_sessions.revoked_at IS NULL
        AND users.disabled_at IS NULL
    `,
    [tokenHash]
  );
  return result.rows[0] ?? null;
}

export async function markAuthSessionSeen(db: Queryable, tokenHash: string): Promise<void> {
  await db.query(
    "UPDATE auth_sessions SET last_seen_at = now() WHERE token_hash = $1",
    [tokenHash]
  );
}

export async function revokeExpiredAuthSessions(db: Queryable): Promise<number> {
  const result = await db.query(
    `
      UPDATE auth_sessions
      SET revoked_at = now()
      WHERE revoked_at IS NULL
        AND expires_at <= now()
    `
  );
  return result.rowCount ?? 0;
}
