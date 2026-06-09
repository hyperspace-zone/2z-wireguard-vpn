import type { EncryptedJsonPayload } from "@hyperspace-zone/shared";
import type { Queryable } from "../../db/queryable.js";
import { insertRenderedPlanSecret, upsertRenderedPlanRecord, type UpsertRenderedPlanInput } from "./repository.js";

export async function upsertRenderedPlan(db: Queryable, input: UpsertRenderedPlanInput): Promise<string> {
  return upsertRenderedPlanRecord(db, input);
}

export async function writeRenderedPlanSecret(
  db: Queryable,
  planId: string,
  payload: EncryptedJsonPayload
): Promise<void> {
  await insertRenderedPlanSecret(db, planId, payload);
}
