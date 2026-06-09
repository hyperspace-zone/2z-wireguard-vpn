import type { EncryptedJsonPayload } from "@hyperspace-zone/shared";
import type { Queryable } from "../../db/queryable.js";

export async function insertRenderedPlanSecret(
  db: Queryable,
  planId: string,
  payload: EncryptedJsonPayload
): Promise<void> {
  await db.query(
    `
      INSERT INTO rendered_plan_secrets (
        plan_id,
        encryption_method,
        nonce,
        ciphertext,
        auth_tag,
        aad,
        key_fingerprint
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (plan_id) DO NOTHING
    `,
    [
      planId,
      payload.encryptionMethod,
      payload.nonce,
      payload.ciphertext,
      payload.authTag,
      payload.aad,
      payload.keyFingerprint
    ]
  );
}
