import type { TransactionalQueryable } from "../../db/queryable.js";
import type { PublicSessionActor } from "./create-session.scenario.js";

export async function activatePaidSession(
  db: TransactionalQueryable,
  actor: PublicSessionActor,
  sessionId: string,
  paymentId: string,
  transactionSignature: string
): Promise<"activated" | "already_active" | "not_found" | "invalid_phase"> {
  return db.transaction(async (client) => {
    const result = await client.query<{ phase: string }>(
      `
        SELECT session_status.phase::text AS phase
        FROM sessions
        JOIN session_status ON session_status.session_id = sessions.id
        WHERE sessions.id = $1 AND sessions.account_id = $2
        FOR UPDATE
      `,
      [sessionId, actor.accountId]
    );
    const phase = result.rows[0]?.phase;
    if (!phase) return "not_found";
    if (phase !== "payment_pending") return phase === "requested" ? "already_active" : "invalid_phase";
    await client.query(
      `
        UPDATE session_status
        SET phase = 'requested', updated_at = now()
        WHERE session_id = $1
      `,
      [sessionId]
    );
    await client.query(
      `
        UPDATE session_conditions
        SET reason = 'PaymentConfirmed',
            message = 'SOL config payment finalized; session is waiting for reconciliation',
            last_transition_at = now()
        WHERE session_id = $1 AND type = 'Ready'
      `,
      [sessionId]
    );
    await client.query(
      `
        INSERT INTO audit_events (event_type, actor_type, actor_id, account_id, session_id, details)
        VALUES ('session_payment_confirmed', 'user', $1, $2, $3, $4::jsonb)
      `,
      [actor.id, actor.accountId, sessionId, JSON.stringify({ paymentId, transactionSignature })]
    );
    return "activated";
  });
}

export async function deleteUnpaidSession(
  db: TransactionalQueryable,
  actor: PublicSessionActor,
  sessionId: string
): Promise<void> {
  await db.transaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `
        SELECT sessions.id
        FROM sessions
        JOIN session_status ON session_status.session_id = sessions.id
        WHERE sessions.id = $1
          AND sessions.account_id = $2
          AND session_status.phase = 'payment_pending'
        FOR UPDATE
      `,
      [sessionId, actor.accountId]
    );
    if (!result.rows[0]) return;
    await client.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
  });
}
