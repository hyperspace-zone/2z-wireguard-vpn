import type { Queryable, TransactionalQueryable } from "../../db/queryable.js";
import { setSessionCondition } from "../../resources/sessions/conditions.js";
import {
  updateSessionDesiredState,
  updateSessionStatusPhase
} from "../../resources/sessions/repository.js";

export const decimalGigabyteBytes = 1_000_000_000n;
export const maxAdminTrafficQuotaGb = 1_000_000n;

interface LockedTrafficQuotaRow {
  sessionId: string;
  accountId: string;
  includedBytes: string;
  consumedBytes: string;
  exhaustedAt: string | null;
  desiredState: string;
  phase: string;
  generation: number;
  quotaRevoked: boolean;
}

export type AdminTrafficQuotaAdjustmentResult =
  | { status: "not_found" | "not_metered" }
  | { status: "below_consumed"; consumedBytes: string }
  | {
      status: "updated";
      sessionId: string;
      includedBytes: string;
      consumedBytes: string;
      remainingBytes: string;
      reactivation: "not_needed" | "requested" | "waiting_for_revocation";
    };

export async function adjustSessionTrafficQuota(
  db: TransactionalQueryable,
  input: {
    sessionId: string;
    includedBytes: bigint;
    adminId: string;
    reason: string;
  }
): Promise<AdminTrafficQuotaAdjustmentResult> {
  return db.transaction(async (client) => {
    const quota = await readTrafficQuotaForUpdate(client, input.sessionId);
    if (!quota) {
      return await sessionExists(client, input.sessionId)
        ? { status: "not_metered" }
        : { status: "not_found" };
    }

    const consumedBytes = BigInt(quota.consumedBytes);
    if (input.includedBytes <= consumedBytes) {
      return { status: "below_consumed", consumedBytes: quota.consumedBytes };
    }

    let reactivation: "not_needed" | "requested" | "waiting_for_revocation" = "not_needed";
    if (quota.quotaRevoked && quota.desiredState === "Revoked" && quota.phase === "revoked") {
      await updateSessionDesiredState(client, {
        sessionId: quota.sessionId,
        desiredState: "Active",
        incrementGeneration: true
      });
      await updateSessionStatusPhase(client, {
        sessionId: quota.sessionId,
        phase: "scheduling",
        lastError: null
      });
      await setSessionCondition(
        client,
        quota.sessionId,
        "Ready",
        "False",
        "QuotaIncreased",
        "Traffic quota increased by an administrator; config reprovisioning is in progress",
        quota.generation + 1
      );
      reactivation = "requested";
    } else if (quota.quotaRevoked && quota.desiredState === "Revoked" && quota.phase === "revoking") {
      reactivation = "waiting_for_revocation";
    }

    const clearExhaustedAt = reactivation !== "waiting_for_revocation"
      && (quota.desiredState === "Active" || reactivation === "requested");
    await client.query(
      `
        UPDATE session_traffic_entitlements
        SET included_bytes = $2,
            exhausted_at = CASE WHEN $3::boolean THEN NULL ELSE exhausted_at END,
            updated_at = now()
        WHERE session_id = $1
      `,
      [quota.sessionId, input.includedBytes.toString(), clearExhaustedAt]
    );
    await client.query(
      `
        INSERT INTO audit_events (event_type, actor_type, actor_id, account_id, session_id, details)
        VALUES ('session_traffic_quota_adjusted', 'admin', $1, $2, $3, $4::jsonb)
      `,
      [
        input.adminId,
        quota.accountId,
        quota.sessionId,
        JSON.stringify({
          previousIncludedBytes: quota.includedBytes,
          includedBytes: input.includedBytes.toString(),
          consumedBytes: quota.consumedBytes,
          reason: input.reason,
          reactivation
        })
      ]
    );

    return {
      status: "updated",
      sessionId: quota.sessionId,
      includedBytes: input.includedBytes.toString(),
      consumedBytes: quota.consumedBytes,
      remainingBytes: (input.includedBytes - consumedBytes).toString(),
      reactivation
    };
  });
}

async function readTrafficQuotaForUpdate(db: Queryable, sessionId: string): Promise<LockedTrafficQuotaRow | null> {
  const result = await db.query<LockedTrafficQuotaRow>(
    `
      SELECT
        sessions.id AS "sessionId",
        sessions.account_id AS "accountId",
        session_traffic_entitlements.included_bytes::text AS "includedBytes",
        session_traffic_entitlements.consumed_bytes::text AS "consumedBytes",
        session_traffic_entitlements.exhausted_at AS "exhaustedAt",
        sessions.desired_state::text AS "desiredState",
        session_status.phase::text AS phase,
        sessions.generation::int AS generation,
        COALESCE(last_revoke.actor_type = 'system'
          AND last_revoke.details->>'code' = 'traffic_quota_exhausted', false) AS "quotaRevoked"
      FROM sessions
      JOIN session_status ON session_status.session_id = sessions.id
      JOIN session_traffic_entitlements ON session_traffic_entitlements.session_id = sessions.id
      LEFT JOIN LATERAL (
        SELECT actor_type, details
        FROM audit_events
        WHERE audit_events.session_id = sessions.id
          AND audit_events.event_type = 'session_revoke_requested'
        ORDER BY audit_events.created_at DESC, audit_events.id DESC
        LIMIT 1
      ) last_revoke ON true
      WHERE sessions.id = $1
        AND sessions.account_id IS NOT NULL
        AND sessions.hidden_at IS NULL
      FOR UPDATE OF sessions, session_status, session_traffic_entitlements
    `,
    [sessionId]
  );
  return result.rows[0] ?? null;
}

async function sessionExists(db: Queryable, sessionId: string): Promise<boolean> {
  const result = await db.query("SELECT 1 FROM sessions WHERE id = $1 AND hidden_at IS NULL", [sessionId]);
  return (result.rowCount ?? result.rows.length) > 0;
}
