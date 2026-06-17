import type { TransactionalQueryable } from "../../db/queryable.js";
import {
  mergeSessionAbuseControlConfig,
  validateSessionAbusePolicy,
  type SessionAbuseControlConfig
} from "../../resources/sessions/abuse-controls.js";
import type { SessionOwner } from "../../resources/sessions/repository.js";
import { createRequestedSessionWithAbuseControls } from "../../resources/sessions/service.js";
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
  body: Record<string, unknown>,
  abuseControls: Partial<SessionAbuseControlConfig> = {}
): Promise<CreateSessionSuccess | CreateSessionFailure> {
  const parsed = parseSessionCreateBody(body);
  if ("error" in parsed) {
    return {
      status: "invalid",
      error: parsed.error,
      ...(parsed.message ? { message: parsed.message } : {})
    };
  }

  const controls = mergeSessionAbuseControlConfig(abuseControls);
  const policyError = validateSessionAbusePolicy(parsed, controls);
  if (policyError) {
    return {
      status: "invalid",
      error: policyError.error,
      message: policyError.message
    };
  }

  const created = await createRequestedSessionWithAbuseControls(db, actor, parsed, controls);
  if (created.status === "rejected") {
    return {
      status: "invalid",
      error: created.error,
      message: created.message
    };
  }

  return {
    status: "created",
    sessionId: created.sessionId
  };
}
