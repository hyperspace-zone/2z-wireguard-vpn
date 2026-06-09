import type { EncryptedJsonPayload } from "@hyperspace-zone/shared";
import type { Queryable } from "../../db/queryable.js";
import { insertRenderedPlanSecret } from "./repository.js";

export async function writeRenderedPlanSecret(
  db: Queryable,
  planId: string,
  payload: EncryptedJsonPayload
): Promise<void> {
  await insertRenderedPlanSecret(db, planId, payload);
}
