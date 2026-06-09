import type { TransactionalQueryable } from "../../db/queryable.js";
import { deleteOwnedHiddenSession } from "../../resources/sessions/service.js";
import type { PublicSessionActor } from "./create-session.scenario.js";

export async function deleteHiddenSession(
  db: TransactionalQueryable,
  actor: PublicSessionActor,
  sessionId: string
): Promise<"deleted" | "not_found" | "not_revoked"> {
  return deleteOwnedHiddenSession(db, actor, sessionId);
}
