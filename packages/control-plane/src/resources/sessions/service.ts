import type { TransactionalQueryable } from "../../db/queryable.js";
import {
  hideRevokedOrFailedSession,
  insertRequestedSession,
  requestSessionRevocation,
  type SessionOwner
} from "./repository.js";
import type { SessionCreateParsed } from "./validation.js";

export async function createRequestedSession(
  db: TransactionalQueryable,
  actor: SessionOwner,
  parsed: SessionCreateParsed
): Promise<string> {
  return insertRequestedSession(db, actor, parsed);
}

export async function requestOwnedSessionRevocation(
  db: TransactionalQueryable,
  actor: SessionOwner,
  sessionId: string
): Promise<boolean> {
  return requestSessionRevocation(db, actor, sessionId);
}

export async function deleteOwnedHiddenSession(
  db: TransactionalQueryable,
  actor: SessionOwner,
  sessionId: string
): Promise<"deleted" | "not_found" | "not_revoked"> {
  return hideRevokedOrFailedSession(db, actor, sessionId);
}
