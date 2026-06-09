import type { Queryable } from "../../db/queryable.js";
import { mustRow } from "../../support/db.js";

export interface CreateEntitlementInput {
  accountId?: string;
  servicePrincipalId?: string;
  paymentId?: string;
  sessionId?: string;
  purchasedDurationSeconds: number;
  effectiveExpiryAt: string;
  metadata: Record<string, unknown>;
}

export async function insertEntitlement(db: Queryable, input: CreateEntitlementInput): Promise<string> {
  const result = await db.query<{ id: string }>(
    `
      INSERT INTO agent_entitlements (
        account_id,
        service_principal_id,
        payment_id,
        session_id,
        purchased_duration_seconds,
        effective_expiry_at,
        metadata
      )
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz, $7::jsonb)
      RETURNING id
    `,
    [
      input.accountId || null,
      input.servicePrincipalId || null,
      input.paymentId || null,
      input.sessionId || null,
      input.purchasedDurationSeconds,
      input.effectiveExpiryAt,
      JSON.stringify(input.metadata)
    ]
  );
  return mustRow(result).id;
}

export async function revokeEntitlementsForSession(db: Queryable, sessionId: string): Promise<void> {
  await db.query(
    `
      UPDATE agent_entitlements
      SET revoked_at = now()
      WHERE session_id = $1
        AND revoked_at IS NULL
    `,
    [sessionId]
  );
}

export async function listExpiredEntitlementSessionIds(db: Queryable): Promise<string[]> {
  const result = await db.query<{ sessionId: string }>(
    `
      SELECT session_id AS "sessionId"
      FROM agent_entitlements
      WHERE session_id IS NOT NULL
        AND revoked_at IS NULL
        AND effective_expiry_at <= now()
      FOR UPDATE SKIP LOCKED
    `
  );
  return [...new Set(result.rows.map((row) => row.sessionId))];
}
