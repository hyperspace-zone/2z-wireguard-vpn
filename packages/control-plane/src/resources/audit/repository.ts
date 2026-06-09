import type { Queryable } from "../../db/queryable.js";

export async function insertGateAuditEvent(
  db: Queryable,
  input: {
    eventType: string;
    gateId: string;
    details: Record<string, unknown>;
  }
): Promise<void> {
  await db.query(
    `
      INSERT INTO audit_events (event_type, actor_type, gate_id, details)
      VALUES ($1, 'system', $2, $3::jsonb)
    `,
    [input.eventType, input.gateId, JSON.stringify(input.details)]
  );
}
