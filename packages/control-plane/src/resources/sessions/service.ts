import type { TransactionalQueryable } from "../../db/queryable.js";
import type { SessionAbuseControlConfig } from "./abuse-controls.js";
import {
  countNonTerminalSessionsForAccount,
  countRecentSessionCreatesForAccount,
  findSessionPhaseForUpdate,
  findOwnedSessionPhaseForUpdate,
  findOwnedSessionVisibilityForUpdate,
  hideOwnedSession,
  insertRequestedSession,
  insertRequestedSessionInTransaction,
  insertSessionHiddenAudit,
  insertUserSessionRejectedAudit,
  insertSystemSessionRevokeRequestedAudit,
  insertUserSessionRevokeRequestedAudit,
  lockAccountForSessionCreate,
  updateSessionDesiredState,
  updateSessionStatusPhase,
  type SessionOwner
} from "./repository.js";
import {
  canHideSession,
  requestRevocationTransition,
  requestedSessionInitialTransition,
  type SessionPhase
} from "./transitions.js";
import type { SessionCreateParsed } from "./validation.js";

export interface CreateRequestedSessionCreated {
  status: "created";
  sessionId: string;
}

export interface CreateRequestedSessionRejected {
  status: "rejected";
  error: string;
  message: string;
}

export async function createRequestedSession(
  db: TransactionalQueryable,
  actor: SessionOwner,
  parsed: SessionCreateParsed
): Promise<string> {
  return insertRequestedSession(db, actor, parsed, {
    initialPhase: requestedSessionInitialTransition().phase
  });
}

export async function createRequestedSessionWithAbuseControls(
  db: TransactionalQueryable,
  actor: SessionOwner,
  parsed: SessionCreateParsed,
  config: SessionAbuseControlConfig
): Promise<CreateRequestedSessionCreated | CreateRequestedSessionRejected> {
  return db.transaction(async (client) => {
    await lockAccountForSessionCreate(client, actor.accountId);

    const activeCount = await countNonTerminalSessionsForAccount(client, actor.accountId);
    if (activeCount >= config.maxActiveSessionsPerAccount) {
      await insertUserSessionRejectedAudit(client, actor, {
        error: "session_quota_exceeded",
        reason: "max_active_sessions_per_account",
        mode: parsed.mode,
        limit: config.maxActiveSessionsPerAccount
      });
      return {
        status: "rejected",
        error: "session_quota_exceeded",
        message: `Self-service account limit reached: ${config.maxActiveSessionsPerAccount} active VPN configs.`
      };
    }

    const recentCreateCount = await countRecentSessionCreatesForAccount(
      client,
      actor.accountId,
      config.sessionCreateWindowSeconds
    );
    if (recentCreateCount >= config.maxSessionCreatesPerWindow) {
      await insertUserSessionRejectedAudit(client, actor, {
        error: "session_create_rate_limited",
        reason: "max_session_creates_per_window",
        mode: parsed.mode,
        limit: config.maxSessionCreatesPerWindow,
        windowSeconds: config.sessionCreateWindowSeconds
      });
      return {
        status: "rejected",
        error: "session_create_rate_limited",
        message: `Self-service account create limit reached: ${config.maxSessionCreatesPerWindow} VPN configs per ${config.sessionCreateWindowSeconds} seconds.`
      };
    }

    return {
      status: "created",
      sessionId: await insertRequestedSessionInTransaction(client, actor, parsed, {
        initialPhase: requestedSessionInitialTransition().phase
      })
    };
  });
}

export async function requestOwnedSessionRevocation(
  db: TransactionalQueryable,
  actor: SessionOwner,
  sessionId: string
): Promise<boolean> {
  return db.transaction(async (client) => {
    const row = await findOwnedSessionPhaseForUpdate(client, actor, sessionId);
    if (!row) {
      return false;
    }

    const transition = requestRevocationTransition(row.phase as SessionPhase);
    await updateSessionDesiredState(client, {
      sessionId,
      desiredState: transition.desiredState,
      incrementGeneration: transition.incrementGeneration
    });
    await updateSessionStatusPhase(client, {
      sessionId,
      ...transition.statusTransition
    });
    await insertUserSessionRevokeRequestedAudit(client, actor, sessionId);
    return true;
  });
}

export async function requestSystemSessionRevocation(
  db: Parameters<typeof findSessionPhaseForUpdate>[0],
  sessionId: string,
  reason: Record<string, unknown>
): Promise<boolean> {
  const row = await findSessionPhaseForUpdate(db, sessionId);
  if (!row) {
    return false;
  }

  const transition = requestRevocationTransition(row.phase as SessionPhase);
  await updateSessionDesiredState(db, {
    sessionId,
    desiredState: transition.desiredState,
    incrementGeneration: transition.incrementGeneration
  });
  await updateSessionStatusPhase(db, {
    sessionId,
    ...transition.statusTransition
  });
  await insertSystemSessionRevokeRequestedAudit(db, sessionId, reason);
  return true;
}

export async function deleteOwnedHiddenSession(
  db: TransactionalQueryable,
  actor: SessionOwner,
  sessionId: string
): Promise<"deleted" | "not_found" | "not_revoked"> {
  return db.transaction(async (client) => {
    const row = await findOwnedSessionVisibilityForUpdate(client, actor, sessionId);
    if (!row) {
      return "not_found";
    }
    const decision = canHideSession(row.phase as SessionPhase, row.hiddenAt);
    if (decision !== "can_hide") {
      return decision;
    }

    await hideOwnedSession(client, actor, sessionId);
    await insertSessionHiddenAudit(client, actor, sessionId);
    return "deleted";
  });
}
