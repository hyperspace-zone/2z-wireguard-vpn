import type { Queryable, TransactionalQueryable } from "../../db/queryable.js";
import {
  consumeOauthLoginChallenge,
  findPublicUserByEmail,
  insertOauthLoginChallenge,
  insertUserWithoutPassword,
  upsertIdentity,
  type PublicUser
} from "../../resources/users/repository.js";
import { newSecretToken, sha256Hex } from "../../security/tokens.js";
import { isUniqueViolation } from "../../support/db.js";
import { createAuthSession } from "./auth-session.js";
import type { AuthSessionResult } from "./register-user.scenario.js";

interface MinimalFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type MinimalFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
) => Promise<MinimalFetchResponse>;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  appRedirectUrl: string;
  stateTtlSeconds: number;
  authSessionTtlSeconds: number;
}

export interface GoogleOAuthStartResult {
  authorizationUrl: string;
  expiresAt: string;
}

export type GoogleOAuthCompleteResult =
  | {
    auth: AuthSessionResult;
    redirectAfter: string;
  }
  | "oauth_state_invalid"
  | "oauth_state_expired"
  | "oauth_exchange_failed"
  | "oauth_email_not_verified";

export async function createGoogleOAuthStart(
  db: TransactionalQueryable,
  config: GoogleOAuthConfig,
  input: {
    redirectAfter?: string;
  }
): Promise<GoogleOAuthStartResult> {
  const state = newSecretToken(24);
  const expiresAt = new Date(Date.now() + config.stateTtlSeconds * 1000).toISOString();
  const stored = await insertOauthLoginChallenge(db, {
    provider: "google",
    stateHash: sha256Hex(state),
    redirectAfter: sanitizeRedirectAfter(input.redirectAfter),
    expiresAt
  });

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");

  return {
    authorizationUrl: url.toString(),
    expiresAt: stored.expiresAt
  };
}

export async function completeGoogleOAuth(
  db: TransactionalQueryable,
  config: GoogleOAuthConfig,
  input: {
    code: string;
    state: string;
    fetchImpl?: MinimalFetch;
  }
): Promise<GoogleOAuthCompleteResult> {
  const stateHash = sha256Hex(input.state);
  return db.transaction(async (client) => {
    const challenge = await consumeOauthLoginChallenge(client, {
      provider: "google",
      stateHash
    });
    if (!challenge) {
      return "oauth_state_invalid";
    }
    if (Date.parse(challenge.expiresAt) <= Date.now()) {
      return "oauth_state_expired";
    }

    const fetchImpl = input.fetchImpl ?? fetch;
    const token = await exchangeGoogleCode(fetchImpl, config, input.code);
    if (!token?.accessToken) {
      return "oauth_exchange_failed";
    }
    const profile = await fetchGoogleProfile(fetchImpl, token.accessToken);
    if (!profile) {
      return "oauth_exchange_failed";
    }
    if (!profile.emailVerified) {
      return "oauth_email_not_verified";
    }

    const user = await findOrCreateGoogleUser(client, profile);
    await upsertIdentity(client, {
      accountId: user.accountId,
      provider: "google",
      providerSubject: profile.sub,
      email: profile.email,
      metadata: {
        name: profile.name,
        picture: profile.picture
      },
      verifiedAt: new Date().toISOString()
    });
    await upsertIdentity(client, {
      accountId: user.accountId,
      provider: "email",
      providerSubject: profile.email,
      email: profile.email,
      metadata: { login: "google" },
      verifiedAt: new Date().toISOString()
    });
    const session = await createAuthSession(user.id, config.authSessionTtlSeconds, client);
    return {
      auth: { user, accessToken: session.token, expiresAt: session.expiresAt },
      redirectAfter: challenge.redirectAfter
    };
  });
}

async function exchangeGoogleCode(
  fetchImpl: MinimalFetch,
  config: GoogleOAuthConfig,
  code: string
): Promise<{ accessToken: string } | null> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUrl,
    grant_type: "authorization_code"
  });
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!response.ok) {
    return null;
  }
  const payload = parseJson(await response.text());
  const accessToken = readString(payload, "access_token");
  return accessToken ? { accessToken } : null;
}

async function fetchGoogleProfile(fetchImpl: MinimalFetch, accessToken: string): Promise<{
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture: string;
} | null> {
  const response = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", {
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    return null;
  }
  const payload = parseJson(await response.text());
  const sub = readString(payload, "sub");
  const email = readString(payload, "email").toLowerCase();
  if (!sub || !email) {
    return null;
  }
  return {
    sub,
    email,
    emailVerified: readBoolean(payload, "email_verified"),
    name: readString(payload, "name"),
    picture: readString(payload, "picture")
  };
}

async function findOrCreateGoogleUser(
  db: Queryable,
  profile: {
    email: string;
    name: string;
  }
): Promise<PublicUser> {
  const existing = await findPublicUserByEmail(db, profile.email);
  if (existing) {
    return existing;
  }
  try {
    return await insertUserWithoutPassword(db, {
      email: profile.email,
      displayName: profile.name || profile.email
    });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const raced = await findPublicUserByEmail(db, profile.email);
    if (!raced) {
      throw error;
    }
    return raced;
  }
}

function sanitizeRedirectAfter(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value.slice(0, 512);
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true || record[key] === "true";
}
