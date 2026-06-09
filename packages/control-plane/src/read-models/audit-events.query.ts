import type { Queryable } from "../db/queryable.js";

export interface AuditEventSummary {
  id: string;
  eventType: string;
  actorType: string;
  actorId?: string;
  accountId?: string;
  sessionId?: string;
  gateId?: string;
  assignmentId?: string;
  details: Record<string, unknown>;
  createdAt: string;
}

interface AuditEventRow {
  id: string;
  eventType: string;
  actorType: string;
  actorId: string | null;
  accountId: string | null;
  sessionId: string | null;
  gateId: string | null;
  assignmentId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export async function listAuditEvents(db: Queryable): Promise<AuditEventSummary[]> {
  const result = await db.query<AuditEventRow>(
    `
      SELECT
        id,
        event_type AS "eventType",
        actor_type AS "actorType",
        actor_id AS "actorId",
        account_id AS "accountId",
        session_id AS "sessionId",
        gate_id AS "gateId",
        assignment_id AS "assignmentId",
        details,
        created_at AS "createdAt"
      FROM audit_events
      ORDER BY created_at DESC
      LIMIT 500
    `
  );
  return result.rows.map((row) => ({
    id: row.id,
    eventType: row.eventType,
    actorType: row.actorType,
    ...(row.actorId ? { actorId: row.actorId } : {}),
    ...(row.accountId ? { accountId: row.accountId } : {}),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(row.gateId ? { gateId: row.gateId } : {}),
    ...(row.assignmentId ? { assignmentId: row.assignmentId } : {}),
    details: row.details,
    createdAt: row.createdAt
  }));
}
