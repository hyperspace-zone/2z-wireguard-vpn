import type { Queryable } from "../../db/queryable.js";

export interface ExhaustedSessionTrafficEntitlementRow {
  sessionId: string;
  accountId: string;
  sessionLabel: string | null;
  includedBytes: string;
  consumedBytes: string;
  phase: string;
}

export async function findExhaustedSessionTrafficEntitlementForUpdate(
  db: Queryable
): Promise<ExhaustedSessionTrafficEntitlementRow | null> {
  const result = await db.query<ExhaustedSessionTrafficEntitlementRow>(
    `
      SELECT
        session_traffic_entitlements.session_id AS "sessionId",
        sessions.account_id AS "accountId",
        sessions.label AS "sessionLabel",
        session_traffic_entitlements.included_bytes::text AS "includedBytes",
        session_traffic_entitlements.consumed_bytes::text AS "consumedBytes",
        session_status.phase::text AS phase
      FROM session_traffic_entitlements
      JOIN sessions ON sessions.id = session_traffic_entitlements.session_id
      JOIN session_status ON session_status.session_id = sessions.id
      WHERE session_traffic_entitlements.exhausted_at IS NULL
        AND session_traffic_entitlements.consumed_bytes >= session_traffic_entitlements.included_bytes
        AND sessions.account_id IS NOT NULL
        AND sessions.desired_state = 'Active'
        AND session_status.phase NOT IN ('revoking', 'revoked', 'failed')
      ORDER BY session_traffic_entitlements.updated_at, session_traffic_entitlements.session_id
      LIMIT 1
      FOR UPDATE OF session_traffic_entitlements, sessions, session_status SKIP LOCKED
    `
  );
  return result.rows[0] ?? null;
}

export async function markSessionTrafficEntitlementExhausted(
  db: Queryable,
  sessionId: string
): Promise<void> {
  await db.query(
    `
      UPDATE session_traffic_entitlements
      SET exhausted_at = COALESCE(exhausted_at, now()), updated_at = now()
      WHERE session_id = $1
    `,
    [sessionId]
  );
}
