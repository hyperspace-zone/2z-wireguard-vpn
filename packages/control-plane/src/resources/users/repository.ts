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

export interface EmailLoginChallengeRow {
  id: string;
  email: string;
  codeHash: string;
  attemptCount: number;
  expiresAt: string;
}

export interface WalletLinkChallengeRow {
  id: string;
  accountId: string;
  userId: string;
  chain: string;
  publicKey: string;
  nonceHash: string;
  message: string;
  expiresAt: string;
}

export interface WalletLinkRow {
  id: string;
  chain: string;
  publicKey: string;
  label: string | null;
  linkedAt: string;
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

export async function findPublicUserByEmail(db: Queryable, email: string): Promise<PublicUser | null> {
  const result = await db.query<PublicUser>(
    `
      SELECT id, account_id AS "accountId", email::text, display_name AS "displayName"
      FROM users
      WHERE email = $1
        AND disabled_at IS NULL
    `,
    [email]
  );
  return result.rows[0] ?? null;
}

export async function insertUserWithoutPassword(
  db: Queryable,
  input: {
    email: string;
    displayName: string;
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
  return mustRow(user);
}

export async function upsertIdentity(
  db: Queryable,
  input: {
    accountId: string;
    provider: string;
    providerSubject: string;
    email?: string;
    metadata?: Record<string, unknown>;
    verifiedAt?: string;
  }
): Promise<void> {
  await db.query(
    `
      INSERT INTO identities (
        account_id,
        provider,
        provider_subject,
        email,
        metadata,
        verified_at,
        last_seen_at
      )
      VALUES ($1, $2, $3, $4::citext, $5::jsonb, $6::timestamptz, now())
      ON CONFLICT (provider, provider_subject) DO UPDATE
      SET account_id = EXCLUDED.account_id,
          email = COALESCE(EXCLUDED.email, identities.email),
          metadata = EXCLUDED.metadata,
          verified_at = COALESCE(EXCLUDED.verified_at, identities.verified_at),
          last_seen_at = now()
    `,
    [
      input.accountId,
      input.provider,
      input.providerSubject,
      input.email ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.verifiedAt ?? null
    ]
  );
}

export async function insertEmailLoginChallenge(
  db: Queryable,
  input: {
    email: string;
    codeHash: string;
    expiresAt: string;
    metadata?: Record<string, unknown>;
  }
): Promise<{ id: string; createdAt: string; expiresAt: string }> {
  const result = await db.query<{ id: string; createdAt: string; expiresAt: string }>(
    `
      INSERT INTO email_login_challenges (email, code_hash, expires_at, metadata)
      VALUES ($1, $2, $3::timestamptz, $4::jsonb)
      RETURNING id, created_at AS "createdAt", expires_at AS "expiresAt"
    `,
    [input.email, input.codeHash, input.expiresAt, JSON.stringify(input.metadata ?? {})]
  );
  return mustRow(result);
}

export async function findLatestEmailLoginChallengeForUpdate(
  db: Queryable,
  email: string
): Promise<EmailLoginChallengeRow | null> {
  const result = await db.query<EmailLoginChallengeRow>(
    `
      SELECT
        id,
        email::text,
        code_hash AS "codeHash",
        attempt_count AS "attemptCount",
        expires_at AS "expiresAt"
      FROM email_login_challenges
      WHERE email = $1
        AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    `,
    [email]
  );
  return result.rows[0] ?? null;
}

export async function consumeEmailLoginChallenge(db: Queryable, challengeId: string): Promise<void> {
  await db.query(
    "UPDATE email_login_challenges SET consumed_at = now() WHERE id = $1",
    [challengeId]
  );
}

export async function incrementEmailLoginChallengeAttempts(db: Queryable, challengeId: string): Promise<void> {
  await db.query(
    "UPDATE email_login_challenges SET attempt_count = attempt_count + 1 WHERE id = $1",
    [challengeId]
  );
}

export async function insertOauthLoginChallenge(
  db: Queryable,
  input: {
    provider: string;
    stateHash: string;
    redirectAfter: string;
    expiresAt: string;
    metadata?: Record<string, unknown>;
  }
): Promise<{ expiresAt: string }> {
  const result = await db.query<{ expiresAt: string }>(
    `
      INSERT INTO oauth_login_challenges (provider, state_hash, redirect_after, expires_at, metadata)
      VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)
      RETURNING expires_at AS "expiresAt"
    `,
    [
      input.provider,
      input.stateHash,
      input.redirectAfter,
      input.expiresAt,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return mustRow(result);
}

export async function consumeOauthLoginChallenge(
  db: Queryable,
  input: {
    provider: string;
    stateHash: string;
  }
): Promise<{ redirectAfter: string; expiresAt: string } | null> {
  const result = await db.query<{ redirectAfter: string; expiresAt: string }>(
    `
      UPDATE oauth_login_challenges
      SET consumed_at = now()
      WHERE id = (
        SELECT id
        FROM oauth_login_challenges
        WHERE provider = $1
          AND state_hash = $2
          AND consumed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      )
      RETURNING redirect_after AS "redirectAfter", expires_at AS "expiresAt"
    `,
    [input.provider, input.stateHash]
  );
  return result.rows[0] ?? null;
}

export async function insertWalletLinkChallenge(
  db: Queryable,
  input: {
    accountId: string;
    userId: string;
    chain: string;
    publicKey: string;
    nonceHash: string;
    message: string;
    expiresAt: string;
    metadata?: Record<string, unknown>;
  }
): Promise<{ expiresAt: string }> {
  const result = await db.query<{ expiresAt: string }>(
    `
      INSERT INTO wallet_link_challenges (
        account_id,
        user_id,
        chain,
        public_key,
        nonce_hash,
        message,
        expires_at,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::jsonb)
      RETURNING expires_at AS "expiresAt"
    `,
    [
      input.accountId,
      input.userId,
      input.chain,
      input.publicKey,
      input.nonceHash,
      input.message,
      input.expiresAt,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return mustRow(result);
}

export async function findLatestWalletLinkChallengeForUpdate(
  db: Queryable,
  input: {
    accountId: string;
    chain: string;
    publicKey: string;
  }
): Promise<WalletLinkChallengeRow | null> {
  const result = await db.query<WalletLinkChallengeRow>(
    `
      SELECT
        id,
        account_id AS "accountId",
        user_id AS "userId",
        chain,
        public_key AS "publicKey",
        nonce_hash AS "nonceHash",
        message,
        expires_at AS "expiresAt"
      FROM wallet_link_challenges
      WHERE account_id = $1
        AND chain = $2
        AND public_key = $3
        AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    `,
    [input.accountId, input.chain, input.publicKey]
  );
  return result.rows[0] ?? null;
}

export async function consumeWalletLinkChallenge(db: Queryable, challengeId: string): Promise<void> {
  await db.query(
    "UPDATE wallet_link_challenges SET consumed_at = now() WHERE id = $1",
    [challengeId]
  );
}

export async function insertWalletLink(
  db: Queryable,
  input: {
    accountId: string;
    userId: string;
    chain: string;
    publicKey: string;
    label?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<WalletLinkRow> {
  const result = await db.query<WalletLinkRow>(
    `
      INSERT INTO wallet_links (account_id, user_id, chain, public_key, label, metadata)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (chain, public_key) WHERE revoked_at IS NULL DO UPDATE
      SET account_id = EXCLUDED.account_id,
          user_id = EXCLUDED.user_id,
          label = COALESCE(EXCLUDED.label, wallet_links.label),
          metadata = EXCLUDED.metadata
      RETURNING id, chain, public_key AS "publicKey", label, linked_at AS "linkedAt"
    `,
    [
      input.accountId,
      input.userId,
      input.chain,
      input.publicKey,
      input.label ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return mustRow(result);
}

export async function listWalletLinks(db: Queryable, accountId: string): Promise<WalletLinkRow[]> {
  const result = await db.query<WalletLinkRow>(
    `
      SELECT id, chain, public_key AS "publicKey", label, linked_at AS "linkedAt"
      FROM wallet_links
      WHERE account_id = $1
        AND revoked_at IS NULL
      ORDER BY linked_at DESC
    `,
    [accountId]
  );
  return result.rows;
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
