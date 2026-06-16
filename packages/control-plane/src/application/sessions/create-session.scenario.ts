import type { TransactionalQueryable } from "../../db/queryable.js";
import type { SessionOwner } from "../../resources/sessions/repository.js";
import { createRequestedSession } from "../../resources/sessions/service.js";
import { parseSessionCreateBody } from "../../resources/sessions/validation.js";

export type PublicSessionActor = SessionOwner;

export interface CreateSessionSuccess {
  status: "created";
  sessionId: string;
}

export interface CreateSessionFailure {
  status: "invalid";
  error: string;
  message?: string;
}

export async function createSession(
  db: TransactionalQueryable,
  actor: PublicSessionActor,
  body: Record<string, unknown>
): Promise<CreateSessionSuccess | CreateSessionFailure> {
  const parsed = parseSessionCreateBody(body);
  if ("error" in parsed) {
    return {
      status: "invalid",
      error: parsed.error,
      ...(parsed.message ? { message: parsed.message } : {})
    };
  }

  return {
    status: "created",
    sessionId: await createRequestedSession(db, actor, parsed)
  };
}
