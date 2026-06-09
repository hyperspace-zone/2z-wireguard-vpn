import type { Queryable } from "../../db/queryable.js";
import { upsertSessionCondition, type SessionConditionStatus } from "./repository.js";

export type ConditionStatus = SessionConditionStatus;

export async function setSessionCondition(
  db: Queryable,
  sessionId: string,
  type: string,
  status: ConditionStatus,
  reason: string,
  message: string,
  observedGeneration: number
): Promise<void> {
  await upsertSessionCondition(db, {
    sessionId,
    type,
    status,
    reason,
    message,
    observedGeneration
  });
}
