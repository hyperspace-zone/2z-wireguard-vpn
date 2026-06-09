import type { TransactionalQueryable } from "../../db/queryable.js";
import { requestOwnedSessionRevocation } from "../../resources/sessions/service.js";
import type { PublicSessionActor } from "./create-session.scenario.js";

export async function revokeSession(
  db: TransactionalQueryable,
  actor: PublicSessionActor,
  sessionId: string
): Promise<"revoked" | "not_found"> {
  const updated = await requestOwnedSessionRevocation(db, actor, sessionId);
  return updated ? "revoked" : "not_found";
}
