import type { EncryptedJsonPayload } from "@hyperspace-zone/shared";
import type { Queryable } from "../../db/queryable.js";

export interface UpsertRenderedPlanInput {
  sessionId: string;
  generation: number;
  planHash: string;
  publicMaterial: Record<string, unknown>;
  routingModel: Record<string, unknown>;
  firewallModel: Record<string, unknown>;
  secretRefs: Record<string, unknown>;
}

export async function upsertRenderedPlanRecord(db: Queryable, input: UpsertRenderedPlanInput): Promise<string> {
  const planRow = await db.query<{ id: string }>(
    `
      INSERT INTO rendered_plans (
        session_id,
        generation,
        plan_hash,
        public_material,
        routing_model,
        firewall_model,
        secret_refs
      )
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb)
      ON CONFLICT (session_id, generation) DO UPDATE
      SET plan_hash = EXCLUDED.plan_hash,
          public_material = EXCLUDED.public_material,
          routing_model = EXCLUDED.routing_model,
          firewall_model = EXCLUDED.firewall_model,
          secret_refs = EXCLUDED.secret_refs
      RETURNING id
    `,
    [
      input.sessionId,
      input.generation,
      input.planHash,
      JSON.stringify(input.publicMaterial),
      JSON.stringify(input.routingModel),
      JSON.stringify(input.firewallModel),
      JSON.stringify(input.secretRefs)
    ]
  );
  const row = planRow.rows[0];
  if (!row) {
    throw new Error("expected rendered plan row");
  }
  return row.id;
}

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
