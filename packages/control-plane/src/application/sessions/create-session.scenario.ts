import type { TransactionalQueryable } from "../../db/queryable.js";
import type { SessionOwner } from "../../resources/sessions/repository.js";
import { createRequestedSession } from "../../resources/sessions/service.js";
import type { SessionCreateParsed } from "../../resources/sessions/validation.js";

export type PublicSessionActor = SessionOwner;

export async function createSession(
  db: TransactionalQueryable,
  actor: PublicSessionActor,
  parsed: SessionCreateParsed
): Promise<string> {
  return createRequestedSession(db, actor, parsed);
}
