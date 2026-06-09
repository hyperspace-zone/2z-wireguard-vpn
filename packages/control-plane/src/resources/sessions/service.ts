import type { TransactionalQueryable } from "../../db/queryable.js";
import {
  findSessionPhaseForUpdate,
  findOwnedSessionPhaseForUpdate,
  findOwnedSessionVisibilityForUpdate,
  hideOwnedSession,
  insertRequestedSession,
  insertSessionHiddenAudit,
  insertSystemSessionRevokeRequestedAudit,
  insertUserSessionRevokeRequestedAudit,
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

export async function createRequestedSession(
  db: TransactionalQueryable,
  actor: SessionOwner,
  parsed: SessionCreateParsed
): Promise<string> {
  return insertRequestedSession(db, actor, parsed, {
    initialPhase: requestedSessionInitialTransition().phase
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
